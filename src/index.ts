#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config.js"
import { CronScheduler } from "./cron/scheduler.js"
import { CronStore } from "./cron/store.js"
import { createMcpServer } from "./mcp.js"
import { startWebhookServer } from "./webhook/server.js"

async function main() {
  const config = loadConfig()

  // Create store and a placeholder scheduler (emitFn wired after MCP connects)
  const store = new CronStore(config.dataDir)

  let emitChannelEvent: (content: string, meta: Record<string, string>) => Promise<void>

  const scheduler = new CronScheduler(async (content, meta) => {
    // Delegate to the real emitFn once it's wired
    await emitChannelEvent(content, meta)
  })

  const { server, emitChannelEvent: emitFn } = createMcpServer(store, scheduler)
  emitChannelEvent = emitFn

  // Connect MCP over stdio — must complete before any notifications
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[clawback] MCP channel connected")

  // Load persistent crons and start scheduling
  const crons = store.load()
  scheduler.startAll(crons)
  console.error(`[clawback] Loaded ${crons.length} persistent cron(s)`)

  // Start webhook HTTP server
  let webhookServer: ReturnType<typeof startWebhookServer> | null = null
  try {
    webhookServer = startWebhookServer({
      port: config.webhookPort,
      host: config.webhookHost,
      emitFn: emitChannelEvent,
      skills: config.skills,
    })
  } catch (err) {
    console.error(
      `[clawback] Webhook server failed to start on ${config.webhookHost}:${config.webhookPort}:`,
      err,
    )
    console.error("[clawback] Continuing with cron-only mode")
  }

  console.error("[clawback] Ready")

  // Graceful shutdown
  const shutdown = () => {
    console.error("[clawback] Shutting down...")
    scheduler.stopAll()
    webhookServer?.stop()
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
