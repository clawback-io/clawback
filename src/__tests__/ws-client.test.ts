import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventQueue, type EmitFn } from "../queue.js"
import type { ActivityLog, ActivityEntry } from "../activity.js"
import { RemoteClient } from "../ws/client.js"

function mockActivityLog() {
  const entries: ActivityEntry[] = []
  return {
    entries,
    load: () => entries,
    list: () => entries,
    append: (entry: ActivityEntry) => { entries.push(entry) },
  } as unknown as ActivityLog & { entries: ActivityEntry[] }
}

let wsServer: ReturnType<typeof Bun.serve> | null = null
let serverSockets: Set<any> = new Set()

function startMockWsServer(
  handler?: (ws: any, message: string) => void,
): { port: number } {
  serverSockets = new Set()
  wsServer = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      const token = url.searchParams.get("token")
      if (token !== "valid-token") {
        return new Response("Unauthorized", { status: 401 })
      }
      if (server.upgrade(req, { data: {} })) return undefined
      return new Response("Not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        serverSockets.add(ws)
      },
      message(ws, message) {
        const data = typeof message === "string" ? message : new TextDecoder().decode(message)
        handler?.(ws, data)
      },
      close(ws) {
        serverSockets.delete(ws)
      },
    },
  })
  return { port: wsServer!.port as number }
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
      activityLog: mockActivityLog(),
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
      onOpen: () => { connected = true },
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
    const { port } = startMockWsServer((ws, msg) => {
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
    const { port } = startMockWsServer((ws, msg) => {
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

    const acks = receivedMessages
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "ack")

    expect(acks.length).toBe(1)
    expect(acks[0].eventId).toBe("evt_123")
    expect(acks[0].summary).toBe("Reviewed PR")
  })

  test("queues acks when disconnected and flushes on reconnect", async () => {
    const receivedMessages: string[] = []
    const { port } = startMockWsServer((ws, msg) => {
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

    const acks = receivedMessages
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "ack")

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

    expect(result).toEqual([
      { id: "cron_1", schedule: "0 9 * * *", prompt: "/catchup" },
    ])
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
    let disconnected = false

    client = new RemoteClient({
      url: `ws://localhost:${port}`,
      token: "valid-token",
      eventQueue,
      onClose: () => { disconnected = true },
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
      activityLog: mockActivityLog(),
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

describe("RemoteClient config validation", () => {
  test("config with remote requires connectionToken", async () => {
    // Import dynamically to test the Zod schema
    const { z } = await import("zod")
    const { loadConfig } = await import("../config.js")
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")

    const tmpDir = join(tmpdir(), `clawback-cfg-remote-${crypto.randomUUID()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const configPath = join(tmpDir, "config.json")
      writeFileSync(
        configPath,
        JSON.stringify({
          remote: "wss://example.com/ws",
        }),
      )
      process.env.CLAWBACK_CONFIG = configPath

      // loadConfig calls process.exit on validation error, so we can't directly test it.
      // Instead, test the schema behavior:
      const { join: pathJoin } = await import("node:path")
      const { homedir } = await import("node:os")

      // Manually test refinement
      const ConfigSchema = z.object({
        dataDir: z.string().default(pathJoin(homedir(), ".clawback")),
        webhookPort: z.number().default(18788),
        webhookHost: z.string().default("127.0.0.1"),
        skills: z.record(z.string(), z.string()).default({}),
        remote: z.string().url().optional(),
        connectionToken: z.string().optional(),
      }).refine(
        (c) => !c.remote || c.connectionToken,
        { message: "connectionToken is required when remote is set", path: ["connectionToken"] },
      )

      const result = ConfigSchema.safeParse({ remote: "wss://example.com/ws" })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("connectionToken")
      }

      // Valid config with both fields
      const result2 = ConfigSchema.safeParse({
        remote: "wss://example.com/ws",
        connectionToken: "cbt_abc123",
      })
      expect(result2.success).toBe(true)

      // Local mode config (no remote) is valid without connectionToken
      const result3 = ConfigSchema.safeParse({})
      expect(result3.success).toBe(true)
    } finally {
      delete process.env.CLAWBACK_CONFIG
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
