import type { EventQueue, QueuedEvent } from "../queue.js"
import {
  type ClientMessage,
  encodeClientMessage,
  parseServerMessage,
  type ServerMessage,
} from "./protocol.js"

export interface RemoteClientOptions {
  url: string
  token: string
  eventQueue: EventQueue
  onOpen?: () => void
  onClose?: () => void
}

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const MIN_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 30_000
const MAX_OFFLINE_ACKS = 1_000
const RECONNECT_JITTER = 0.3

export class RemoteClient {
  private ws: WebSocket | null = null
  private reconnectMs = MIN_RECONNECT_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private offlineAcks: ClientMessage[] = []
  private closed = false

  private url: string
  private token: string
  private eventQueue: EventQueue
  private onOpen?: () => void
  private onClose?: () => void

  constructor(opts: RemoteClientOptions) {
    this.url = opts.url
    this.token = opts.token
    this.eventQueue = opts.eventQueue
    this.onOpen = opts.onOpen
    this.onClose = opts.onClose
  }

  connect(): void {
    if (this.closed) return

    console.error(`[clawback] Connecting to remote: ${this.url}`)

    try {
      this.ws = new WebSocket(this.url)
    } catch (err) {
      console.error("[clawback] WebSocket creation failed:", err)
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      // Authenticate via first message instead of URL query param
      this.send({ type: "auth", token: this.token })
    }

    this.ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data)
      this.handleMessage(data)
    }

    this.ws.onclose = (ev) => {
      console.error(
        `[clawback] Remote disconnected (code=${ev.code}, reason=${ev.reason || "none"})`,
      )
      this.cleanup()
      this.onClose?.()
      this.scheduleReconnect()
    }

    this.ws.onerror = (ev) => {
      console.error("[clawback] WebSocket error:", ev)
    }
  }

  private handleMessage(data: string): void {
    this.resetHeartbeat()

    const msg = parseServerMessage(data)
    if (!msg) {
      console.error("[clawback] Unparseable server message, ignoring")
      return
    }

    switch (msg.type) {
      case "auth_ok":
        console.error("[clawback] Remote connected")
        this.reconnectMs = MIN_RECONNECT_MS
        this.resetHeartbeat()
        this.flushOfflineAcks()
        this.onOpen?.()
        break

      case "ping":
        this.send({ type: "pong" })
        break

      case "event":
        this.handleEvent(msg)
        break

      case "response":
        this.handleResponse(msg)
        break
    }
  }

  private handleEvent(msg: Extract<ServerMessage, { type: "event" }>): void {
    const event: QueuedEvent = {
      content: msg.content,
      meta: { ...msg.meta, remoteEventId: msg.id },
    }
    this.eventQueue.enqueue(event)
  }

  private handleResponse(msg: Extract<ServerMessage, { type: "response" }>): void {
    const pending = this.pendingRequests.get(msg.requestId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingRequests.delete(msg.requestId)

    if (msg.error) {
      pending.reject(new Error(msg.error))
    } else {
      pending.resolve(msg.data)
    }
  }

  /** Send an ack for a completed event back to the remote server. */
  sendAck(eventId: string, summary: string): void {
    const msg: ClientMessage = { type: "ack", eventId, summary }
    if (this.isConnected()) {
      this.send(msg)
    } else {
      if (this.offlineAcks.length >= MAX_OFFLINE_ACKS) {
        console.error(
          `[clawback] WARNING: Offline ack queue is full (${MAX_OFFLINE_ACKS}). Dropping oldest ack.`,
        )
        this.offlineAcks.shift()
      }
      this.offlineAcks.push(msg)
    }
  }

  /** Send a request and wait for a response with matching requestId. */
  async request(msg: ClientMessage & { requestId: string }): Promise<unknown> {
    if (!this.isConnected()) {
      throw new Error("Not connected to remote server")
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.requestId)
        reject(new Error("Request timed out"))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(msg.requestId, { resolve, reject, timer })
      this.send(msg)
    })
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  shutdown(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.cleanup()
    if (this.ws) {
      this.ws.close(1000, "shutdown")
      this.ws = null
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeClientMessage(msg))
    }
  }

  private flushOfflineAcks(): void {
    const acks = this.offlineAcks.splice(0)
    for (const ack of acks) {
      this.send(ack)
    }
    if (acks.length > 0) {
      console.error(`[clawback] Flushed ${acks.length} offline ack(s)`)
    }
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = setTimeout(() => {
      console.error("[clawback] Heartbeat timeout — reconnecting")
      this.ws?.close(4000, "heartbeat timeout")
    }, HEARTBEAT_TIMEOUT_MS)
  }

  private scheduleReconnect(): void {
    if (this.closed) return

    // Apply +/-30% random jitter to the base delay
    const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER
    const delayMs = Math.round(this.reconnectMs * jitter)

    console.error(`[clawback] Reconnecting in ${delayMs}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delayMs)

    // Exponential backoff (base delay still doubles)
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS)
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Connection closed"))
      this.pendingRequests.delete(id)
    }
  }
}
