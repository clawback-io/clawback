import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cron } from "croner"
import type { EventQueue } from "./queue.js"
import type { RemoteClient } from "./ws/client.js"

export interface McpServerOptions {
  eventQueue: EventQueue
  remoteClient: RemoteClient
}

export function createMcpServer(opts: McpServerOptions) {
  const { eventQueue, remoteClient } = opts

  const server = new Server(
    { name: "clawback", version: "0.2.0" },
    {
      capabilities: {
        tools: {},
        experimental: { "claude/channel": {} },
      },
      instructions: [
        "Clawback is a channel that delivers two kinds of events:",
        "",
        '1. **Webhook events** (meta.source = "webhook"): Raw HTTP payloads from external services.',
        "   You MUST act on these events, not just acknowledge them. Analyze the payload and take action:",
        "   - If the payload contains a URL to a PR or issue, review it or respond to it.",
        "   - If it looks like an error/alert, investigate the issue using available tools.",
        "   - If it contains a task or request, execute it.",
        '   - Use the meta.path (e.g., "/github", "/sentry") as a hint about the source.',
        "   - If you truly cannot determine what action to take, ask the user.",
        "",
        '2. **Cron events** (meta.source = "cron"): Scheduled prompts that fire on a timer.',
        "   The content is the prompt or skill to execute — run it immediately as if the user typed it.",
        "",
        "Use the cron_create, cron_delete, and cron_list tools to manage persistent cron schedules.",
        "Crons are stored on the remote server and survive across sessions.",
        "",
        "**IMPORTANT**: After you finish handling ANY channel event (webhook or cron), you MUST call the `event_ack` tool with a brief summary of what you did.",
        "Events are queued and delivered one at a time — the next event will not arrive until you call `event_ack`.",
        'If you see a notification with meta.type = "ack_reminder", do NOT stop what you are doing. Just call `event_ack` when you are naturally done.',
      ].join("\n"),
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "cron_create",
        description:
          "Create a persistent cron job. Specify a 5-field cron schedule and the prompt/skill to run when it fires. Survives across sessions.",
        inputSchema: {
          type: "object" as const,
          properties: {
            schedule: {
              type: "string",
              description:
                'Standard 5-field cron expression (e.g., "0 9 * * *" for daily at 9am, "*/5 * * * *" for every 5 minutes)',
            },
            prompt: {
              type: "string",
              description:
                'The prompt or skill to invoke when the cron fires (e.g., "/catchup", "/review-pr", or freeform text)',
            },
            label: {
              type: "string",
              description: "Optional human-friendly label for this cron job",
            },
          },
          required: ["schedule", "prompt"],
        },
      },
      {
        name: "cron_delete",
        description: "Delete a persistent cron job by its ID.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "The cron job ID to delete",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "cron_list",
        description: "List all persistent cron jobs with their IDs, schedules, and prompts.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "event_ack",
        description:
          "Acknowledge that you have finished processing the current channel event (webhook or cron). You MUST call this after handling every channel event. The next queued event will not be delivered until you do.",
        inputSchema: {
          type: "object" as const,
          properties: {
            summary: {
              type: "string",
              description:
                'Brief summary of what you did to handle this event (e.g., "Reviewed PR #42 — approved with 2 comments"). Logged for activity history.',
            },
          },
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
      case "cron_create": {
        const schedule = args?.schedule as string
        const prompt = args?.prompt as string
        const label = args?.label as string | undefined

        // Validate cron expression locally before sending to server
        try {
          new Cron(schedule, { maxRuns: 0 })
        } catch {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid cron expression: "${schedule}". Use 5-field format: minute hour day-of-month month day-of-week`,
              },
            ],
          }
        }

        try {
          const data = await remoteClient.request({
            type: "cron_create",
            requestId: crypto.randomUUID(),
            schedule,
            prompt,
            label,
          })
          const result = data as { id: string; schedule: string; prompt: string; label?: string }
          return {
            content: [
              {
                type: "text" as const,
                text: `Cron created: ${result.id}\n  Schedule: ${result.schedule}\n  Prompt: ${result.prompt}${result.label ? `\n  Label: ${result.label}` : ""}`,
              },
            ],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to create cron: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "cron_delete": {
        const id = args?.id as string

        try {
          const data = await remoteClient.request({
            type: "cron_delete",
            requestId: crypto.randomUUID(),
            cronId: id,
          })
          const result = data as { removed: boolean }
          return {
            content: [
              {
                type: "text" as const,
                text: result.removed ? `Cron ${id} deleted.` : `Cron ${id} not found.`,
              },
            ],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to delete cron: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "cron_list": {
        try {
          const data = await remoteClient.request({
            type: "cron_list",
            requestId: crypto.randomUUID(),
          })
          const crons = data as Array<{
            id: string
            schedule: string
            prompt: string
            label?: string
          }>
          if (crons.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No cron jobs configured." }],
            }
          }
          const lines = crons.map(
            (c) =>
              `- ${c.id} | ${c.schedule} | ${c.label ?? "(no label)"} | ${c.prompt}`,
          )
          return {
            content: [
              {
                type: "text" as const,
                text: `Cron jobs (${crons.length}):\n${lines.join("\n")}`,
              },
            ],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to list crons: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "event_ack": {
        const summary = (args?.summary as string | undefined) ?? ""
        const pending = eventQueue.pending

        // Send ack to the remote server
        if (eventQueue.busy) {
          const remoteEventId = eventQueue.inflightMeta?.remoteEventId
          if (remoteEventId) {
            remoteClient.sendAck(remoteEventId, summary)
          }
        }

        eventQueue.ack(summary)
        return {
          content: [
            {
              type: "text" as const,
              text: pending > 0
                ? `Acknowledged. ${pending} event${pending === 1 ? "" : "s"} still queued — next one incoming.`
                : "Acknowledged. No more events in the queue.",
            },
          ],
        }
      }

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        }
    }
  })

  async function emitChannelEvent(content: string, meta: Record<string, string>): Promise<void> {
    await server.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    })
  }

  return { server, emitChannelEvent }
}
