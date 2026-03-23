#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config.js"
import { createMcpServer } from "./mcp.js"
import { EventQueue } from "./queue.js"
import { RemoteClient } from "./ws/client.js"

async function main() {
  const config = loadConfig()

  // emitChannelEvent will be set once MCP connects
  let emitChannelEvent: (content: string, meta: Record<string, string>) => Promise<void>

  // Event queue gates dispatch — one event at a time
  const eventQueue = new EventQueue({
    emitFn: async (content, meta) => {
      await emitChannelEvent(content, meta)
    },
  })

  const sessionTag = process.env.CLAWBACK_SESSION || undefined

  const remoteClient = new RemoteClient({
    url: config.remote,
    token: config.connectionToken,
    sessionTag,
    eventQueue,
  })

  const { server, emitChannelEvent: emitFn } = createMcpServer({
    eventQueue,
    remoteClient,
  })
  emitChannelEvent = emitFn

  // Connect MCP over stdio — must complete before any notifications
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[clawback] MCP channel connected")

  // Connect to remote server
  remoteClient.connect()
  console.error(`[clawback] Connecting to ${config.remote}`)
  if (sessionTag) {
    console.error(`[clawback] Session tag: ${sessionTag}`)
  }

  console.error("[clawback] Ready")

  // Graceful shutdown
  const shutdown = () => {
    console.error("[clawback] Shutting down...")
    remoteClient.shutdown()
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
