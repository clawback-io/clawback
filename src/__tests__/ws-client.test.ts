import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { type EmitFn, EventQueue } from "../queue.js"
import { RemoteClient } from "../ws/client.js"

let wsServer: ReturnType<typeof Bun.serve> | null = null
let serverSockets: Set<Bun.ServerWebSocket<unknown>> = new Set()

function startMockWsServer(handler?: (ws: Bun.ServerWebSocket<unknown>, message: string) => void): {
  port: number
} {
  serverSockets = new Set()
  wsServer = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: { authenticated: false } })) return undefined
      return new Response("Not found", { status: 404 })
    },
    websocket: {
      open(_ws) {
        // Wait for auth message before adding to active sockets
      },
      message(ws, message) {
        const data = typeof message === "string" ? message : new TextDecoder().decode(message)
        try {
          const msg = JSON.parse(data)
          if (msg.type === "auth") {
            if (msg.token === "valid-token") {
              ;(ws.data as Record<string, unknown>).authenticated = true
              ws.send(JSON.stringify({ type: "auth_ok" }))
              serverSockets.add(ws)
            } else {
              ws.close(4001, "Invalid token")
            }
            return
          }
        } catch {
          // Not JSON, pass through
        }
        handler?.(ws, data)
      },
      close(ws) {
        serverSockets.delete(ws)
      },
    },
  })
  return { port: wsServer?.port as number }
}

afterEach(() => {
  if (wsServer) {
    wsServer.stop(true)
    wsServer = null
  }
  serverSockets.clear()
})

describe("RemoteClient", () => {
  let client: RemoteClient
  let eventQueue: EventQueue

  beforeEach(() => {
    const emitFn = mock<EmitFn>(async () => {})
    eventQueue = new EventQueue({
      emitFn,
    })
  })

  afterEach(() => {
    client?.shutdown()
    eventQueue?.shutdown()
  })

  test("connects to server with valid token", async () => {
    const { port } = startMockWsServer()
    let connected = false

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue,
      onOpen: () => {
        connected = true
      },
    })
    client.connect()

    await new Promise((r) => setTimeout(r, 100))
    expect(connected).toBe(true)
    expect(client.isConnected()).toBe(true)
  })

  test("receives events and enqueues them", async () => {
    const { port } = startMockWsServer()

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue,
    })
    client.connect()

    await new Promise((r) => setTimeout(r, 100))

    // Server sends an event
    for (const ws of serverSockets) {
      ws.send(
        JSON.stringify({
          type: "event",
          id: "evt_remote1",
          content: "PR #42 opened",
          meta: { source: "webhook", path: "/github" },
        }),
      )
    }

    await new Promise((r) => setTimeout(r, 50))

    // The event should be inflight in the queue
    expect(eventQueue.busy).toBe(true)
  })

  test("responds to ping with pong", async () => {
    const receivedMessages: string[] = []
    const { port } = startMockWsServer((_ws, msg) => {
      receivedMessages.push(msg)
    })

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue,
    })
    client.connect()

    await new Promise((r) => setTimeout(r, 100))

    // Server sends a ping
    for (const ws of serverSockets) {
      ws.send(JSON.stringify({ type: "ping" }))
    }

    await new Promise((r) => setTimeout(r, 50))

    const pongs = receivedMessages.filter((m) => {
      const parsed = JSON.parse(m)
      return parsed.type === "pong"
    })
    expect(pongs.length).toBe(1)
  })

  test("sends ack to server", async () => {
    const receivedMessages: string[] = []
    const { port } = startMockWsServer((_ws, msg) => {
      receivedMessages.push(msg)
    })

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue,
    })
    client.connect()

    await new Promise((r) => setTimeout(r, 100))

    client.sendAck("evt_123", "Reviewed PR")

    await new Promise((r) => setTimeout(r, 50))

    const acks = receivedMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "ack")

    expect(acks.length).toBe(1)
    expect(acks[0].eventId).toBe("evt_123")
    expect(acks[0].summary).toBe("Reviewed PR")
  })

  test("queues acks when disconnected and flushes on reconnect", async () => {
    const receivedMessages: string[] = []
    const { port } = startMockWsServer((_ws, msg) => {
      receivedMessages.push(msg)
    })

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue,
    })

    // Send ack before connecting — should be queued offline
    client.sendAck("evt_offline", "Done offline")
    expect(client.isConnected()).toBe(false)

    client.connect()
    await new Promise((r) => setTimeout(r, 200))

    const acks = receivedMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "ack")

    expect(acks.length).toBe(1)
    expect(acks[0].eventId).toBe("evt_offline")
  })

  test("request resolves on server response", async () => {
    const { port } = startMockWsServer((ws, msg) => {
      const parsed = JSON.parse(msg)
      if (parsed.type === "cron_list") {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: parsed.requestId,
            data: [{ id: "cron_1", schedule: "0 9 * * *", prompt: "/catchup" }],
          }),
        )
      }
    })

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue,
    })
    client.connect()

    await new Promise((r) => setTimeout(r, 100))

    const result = await client.request({
      type: "cron_list",
      requestId: "req_test",
    })

    expect(result).toEqual([{ id: "cron_1", schedule: "0 9 * * *", prompt: "/catchup" }])
  })

  test("request rejects on server error response", async () => {
    const { port } = startMockWsServer((ws, msg) => {
      const parsed = JSON.parse(msg)
      if (parsed.type === "cron_delete") {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: parsed.requestId,
            data: null,
            error: "cron not found",
          }),
        )
      }
    })

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue,
    })
    client.connect()

    await new Promise((r) => setTimeout(r, 100))

    await expect(
      client.request({
        type: "cron_delete",
        requestId: "req_del",
        cronId: "nonexistent",
      }),
    ).rejects.toThrow("cron not found")
  })

  test("request rejects when not connected", async () => {
    client = new RemoteClient({
      url: "ws://localhost:1",
      token: "valid-token",
      eventQueue,
    })

    await expect(
      client.request({
        type: "cron_list",
        requestId: "req_fail",
      }),
    ).rejects.toThrow("Not connected")
  })

  test("shutdown closes connection", async () => {
    const { port } = startMockWsServer()
    let _disconnected = false

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue,
      onClose: () => {
        _disconnected = true
      },
    })
    client.connect()

    await new Promise((r) => setTimeout(r, 100))
    expect(client.isConnected()).toBe(true)

    client.shutdown()

    await new Promise((r) => setTimeout(r, 100))
    expect(client.isConnected()).toBe(false)
  })

  test("adds remoteEventId to enqueued event meta", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    const queue = new EventQueue({
      emitFn,
    })

    const { port } = startMockWsServer()

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue: queue,
    })
    client.connect()

    await new Promise((r) => setTimeout(r, 100))

    for (const ws of serverSockets) {
      ws.send(
        JSON.stringify({
          type: "event",
          id: "evt_remote_abc",
          content: "test event",
          meta: { source: "webhook" },
        }),
      )
    }

    await new Promise((r) => setTimeout(r, 50))

    expect(emitFn).toHaveBeenCalledTimes(1)
    const meta = emitFn.mock.calls[0][1]
    expect(meta.remoteEventId).toBe("evt_remote_abc")
    expect(meta.source).toBe("webhook")

    queue.shutdown()
  })
})
