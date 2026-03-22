#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config.js"
import { ActivityLog } from "./activity.js"
import { CronScheduler } from "./cron/scheduler.js"
import { CronStore } from "./cron/store.js"
import { EventQueue } from "./queue.js"
import { createMcpServer } from "./mcp.js"
import { startWebhookServer } from "./webhook/server.js"
import { RemoteClient } from "./ws/client.js"

async function main() {
  const config = loadConfig()
  const isRemote = !!config.remote

  const store = new CronStore(config.dataDir)
  const activityLog = new ActivityLog(config.dataDir)

  // emitChannelEvent will be set once MCP connects
  let emitChannelEvent: (content: string, meta: Record<string, string>) => Promise<void>

  // Event queue gates dispatch — one event at a time
  const eventQueue = new EventQueue({
    emitFn: async (content, meta) => {
      await emitChannelEvent(content, meta)
    },
    activityLog,
  })

  const scheduler = new CronScheduler(eventQueue)

  // In remote mode, create a WebSocket client to the remote server
  let remoteClient: RemoteClient | undefined
  if (isRemote) {
    remoteClient = new RemoteClient({
      url: config.remote!,
      token: config.connectionToken!,
      eventQueue,
    })
  }

  const { server, emitChannelEvent: emitFn } = createMcpServer({
    store,
    scheduler,
    eventQueue,
    remoteClient,
  })
  emitChannelEvent = emitFn

  // Connect MCP over stdio — must complete before any notifications
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[clawback] MCP channel connected")

  // Track webhook server for shutdown
  let webhookServer: ReturnType<typeof startWebhookServer> | null = null

  if (isRemote) {
    // Remote mode: connect WS client (events come from remote server)
    remoteClient!.connect()
    console.error("[clawback] Running in remote mode")
  } else {
    // Local mode: start cron scheduler + webhook server
    const crons = store.load()
    scheduler.startAll(crons)
    console.error(`[clawback] Loaded ${crons.length} persistent cron(s)`)

    try {
      webhookServer = startWebhookServer({
        port: config.webhookPort,
        host: config.webhookHost,
        eventQueue,
        skills: config.skills,
      })
    } catch (err) {
      console.error(
        `[clawback] Webhook server failed to start on ${config.webhookHost}:${config.webhookPort}:`,
        err,
      )
      console.error("[clawback] Continuing with cron-only mode")
    }
  }

  console.error("[clawback] Ready")

  // Graceful shutdown
  const shutdown = () => {
    console.error("[clawback] Shutting down...")
    if (isRemote) {
      remoteClient!.shutdown()
    } else {
      scheduler.stopAll()
      webhookServer?.stop()
    }
    eventQueue.shutdown()
    server.close()
    process.exit(0)
  }

  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

main().catch((err) => {
  console.error("[clawback] Fatal error:", err)
  process.exit(1)
})
