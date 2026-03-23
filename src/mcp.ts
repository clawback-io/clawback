import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cron } from "croner"
import type { EventQueue } from "./queue.js"
import type { RemoteClient } from "./ws/client.js"

export interface McpServerOptions {
  eventQueue: EventQueue
  remoteClient: RemoteClient
}

/** Error messages that are safe to forward to the client as-is. */
const KNOWN_ERRORS = ["Not connected to remote server", "Request timed out", "Connection closed"]

/** Returns a safe error message for the client. Known errors pass through; unknown errors are sanitized. */
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (KNOWN_ERRORS.includes(err.message)) {
      return err.message
    }
    console.error("[clawback] Tool request failed:", err.message)
    return "Request failed"
  }
  console.error("[clawback] Tool request failed:", err)
  return "Request failed"
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
      {
        name: "source_create",
        description:
          "Create a webhook source. External services POST to the webhook URL with this source slug. Supports HMAC verification (github, stripe, generic, none).",
        inputSchema: {
          type: "object" as const,
          properties: {
            slug: {
              type: "string",
              description: 'URL slug for the webhook endpoint (e.g., "github", "sentry", "deploy")',
            },
            eventType: {
              type: "object",
              description:
                'Tells the server how to extract the event type from incoming webhooks. Use "header" to read from an HTTP header, "body" for a dot-notation JSON path, and "action" for a sub-action to append. Examples: GitHub: {header: "X-GitHub-Event", action: "action"}, Stripe: {body: "type"}, Shopify: {header: "X-Shopify-Topic"}',
              properties: {
                header: {
                  type: "string",
                  description: "HTTP header name to read the event type from",
                },
                body: {
                  type: "string",
                  description: 'Dot-notation path into the JSON body (e.g., "type", "event.type")',
                },
                action: {
                  type: "string",
                  description:
                    'Dot-notation body path for a sub-action, appended with "." (e.g., "action")',
                },
              },
            },
            type: {
              type: "string",
              description:
                'Signature verification type: "github" (X-Hub-Signature-256), "stripe" (Stripe-Signature), "generic" (HMAC-SHA256), or "none" (no verification). Default: "generic"',
            },
            secret: {
              type: "string",
              description: 'Webhook secret for HMAC verification. Not needed if type is "none".',
            },
            skill: {
              type: "string",
              description:
                "Deprecated — use routes instead. Optional skill or prompt to prepend when this webhook fires.",
            },
            routes: {
              type: "object",
              description:
                'Map of event type patterns to skills/prompts. Keys are event types (e.g., "pull_request.opened", "payment_intent.succeeded"), values are skills (e.g., "/review"). Use "*" as a catch-all. Unmatched events are dropped. Requires eventType to be configured.',
              additionalProperties: { type: "string" },
            },
          },
          required: ["slug"],
        },
      },
      {
        name: "source_list",
        description:
          "List all configured webhook sources with their slugs, verification types, and skills.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "source_delete",
        description: "Delete a webhook source by its ID.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "The webhook source ID to delete",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "activity_list",
        description:
          "View recent activity log — shows what events were processed, summaries, and timing.",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: {
              type: "number",
              description: "Number of recent entries to return (default: 20, max: 100)",
            },
          },
        },
      },
      {
        name: "account_info",
        description:
          "Show account info including the webhook base URL for configuring external services.",
        inputSchema: {
          type: "object" as const,
          properties: {},
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
                text: `Failed to create cron: ${safeErrorMessage(err)}`,
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
                text: `Failed to delete cron: ${safeErrorMessage(err)}`,
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
            (c) => `- ${c.id} | ${c.schedule} | ${c.label ?? "(no label)"} | ${c.prompt}`,
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
                text: `Failed to list crons: ${safeErrorMessage(err)}`,
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
              text:
                pending > 0
                  ? `Acknowledged. ${pending} event${pending === 1 ? "" : "s"} still queued — next one incoming.`
                  : "Acknowledged. No more events in the queue.",
            },
          ],
        }
      }

      case "source_create": {
        const slug = args?.slug as string
        const type = (args?.type as string | undefined) ?? "generic"
        const secret = args?.secret as string | undefined
        const skill = args?.skill as string | undefined
        const routes = args?.routes as Record<string, string> | undefined
        const eventType = args?.eventType as
          | { header?: string; body?: string; action?: string }
          | undefined

        try {
          const data = await remoteClient.request({
            type: "source_create",
            requestId: crypto.randomUUID(),
            slug,
            verifierType: type,
            secret,
            skill,
            routes,
            eventType,
          })
          const result = data as {
            id: string
            slug: string
            type: string
            skill?: string
            routes?: Record<string, string>
            eventType?: { header?: string; body?: string; action?: string }
          }
          const details = [
            `Webhook source created: ${result.slug}`,
            `  ID: ${result.id}`,
            `  Verification: ${result.type}`,
          ]
          if (result.eventType && (result.eventType.header || result.eventType.body)) {
            const parts: string[] = []
            if (result.eventType.header) parts.push(`header: ${result.eventType.header}`)
            if (result.eventType.body) parts.push(`body: ${result.eventType.body}`)
            if (result.eventType.action) parts.push(`action: ${result.eventType.action}`)
            details.push(`  Event type: {${parts.join(", ")}}`)
          }
          if (result.routes && Object.keys(result.routes).length > 0) {
            details.push("  Routes:")
            for (const [pattern, target] of Object.entries(result.routes)) {
              details.push(`    ${pattern} -> ${target}`)
            }
          } else if (result.skill) {
            details.push(`  Skill: ${result.skill}`)
          }
          return {
            content: [
              {
                type: "text" as const,
                text: details.join("\n"),
              },
            ],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to create source: ${safeErrorMessage(err)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "source_list": {
        try {
          const data = await remoteClient.request({
            type: "source_list",
            requestId: crypto.randomUUID(),
          })
          const sources = data as Array<{
            id: string
            slug: string
            type: string
            skill?: string
            routes?: Record<string, string>
          }>
          if (sources.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No webhook sources configured." }],
            }
          }
          const lines = sources.map((s) => {
            const routing =
              s.routes && Object.keys(s.routes).length > 0
                ? `routes: {${Object.entries(s.routes)
                    .map(([k, v]) => `${k}->${v}`)
                    .join(", ")}}`
                : s.skill || "(no skill)"
            return `- ${s.slug} | ${s.type} | ${routing} | ID: ${s.id}`
          })
          return {
            content: [
              {
                type: "text" as const,
                text: `Webhook sources (${sources.length}):\n${lines.join("\n")}`,
              },
            ],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to list sources: ${safeErrorMessage(err)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "source_delete": {
        const id = args?.id as string
        try {
          const data = await remoteClient.request({
            type: "source_delete",
            requestId: crypto.randomUUID(),
            sourceId: id,
          })
          const result = data as { removed: boolean }
          return {
            content: [
              {
                type: "text" as const,
                text: result.removed ? `Source ${id} deleted.` : `Source ${id} not found.`,
              },
            ],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to delete source: ${safeErrorMessage(err)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "activity_list": {
        const limit = args?.limit as number | undefined
        try {
          const data = await remoteClient.request({
            type: "activity_list",
            requestId: crypto.randomUUID(),
            limit,
          })
          const entries = data as Array<{
            source: string
            path: string
            skill: string
            summary: string
            completedAt: string
            durationMs: number
            timedOut: boolean
          }>
          if (entries.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No activity recorded yet." }],
            }
          }
          const lines = entries.map((e) => {
            const dur =
              e.durationMs < 1000 ? `${e.durationMs}ms` : `${(e.durationMs / 1000).toFixed(1)}s`
            const timeout = e.timedOut ? " [TIMED OUT]" : ""
            return `- ${e.completedAt} | ${e.source}${e.path ? ` ${e.path}` : ""} | ${dur}${timeout}\n  ${e.summary || "(no summary)"}`
          })
          return {
            content: [
              {
                type: "text" as const,
                text: `Recent activity (${entries.length}):\n${lines.join("\n")}`,
              },
            ],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to list activity: ${safeErrorMessage(err)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "account_info": {
        try {
          const data = await remoteClient.request({
            type: "account_info",
            requestId: crypto.randomUUID(),
          })
          const info = data as {
            profileId: string
            webhookId: string
            webhookBaseUrl: string
            connectedClients: number
          }
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Account info:`,
                  `  Profile ID: ${info.profileId}`,
                  `  Webhook base URL: ${info.webhookBaseUrl}`,
                  `  Connected clients: ${info.connectedClients}`,
                  ``,
                  `To receive webhooks, configure external services to POST to:`,
                  `  ${info.webhookBaseUrl}/<source-slug>`,
                ].join("\n"),
              },
            ],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to get account info: ${safeErrorMessage(err)}`,
              },
            ],
            isError: true,
          }
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
