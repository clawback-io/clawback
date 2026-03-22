import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Cron } from "croner"
import { CronStore } from "./cron/store.js"
import { CronScheduler } from "./cron/scheduler.js"

export function createMcpServer(store: CronStore, scheduler: CronScheduler) {
  const server = new Server(
    { name: "clawback", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        experimental: { "claude/channel": {} },
      },
      instructions: [
        "Clawback is a channel that delivers two kinds of events:",
        "",
        "1. **Webhook events** (meta.source = \"webhook\"): Raw HTTP payloads from external services.",
        "   You MUST act on these events, not just acknowledge them. Analyze the payload and take action:",
        "   - If the payload contains a URL to a PR or issue, review it or respond to it.",
        "   - If it looks like an error/alert, investigate the issue using available tools.",
        "   - If it contains a task or request, execute it.",
        "   - Use the meta.path (e.g., \"/github\", \"/sentry\") as a hint about the source.",
        "   - If you truly cannot determine what action to take, ask the user.",
        "",
        "2. **Cron events** (meta.source = \"cron\"): Scheduled prompts that fire on a timer.",
        "   The content is the prompt or skill to execute — run it immediately as if the user typed it.",
        "",
        "Use the cron_create, cron_delete, and cron_list tools to manage persistent cron schedules.",
        "Crons survive across sessions — they are stored on disk.",
      ].join("\n"),
    },
  )

  // Register tools
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
        description:
          "List all persistent cron jobs with their IDs, schedules, and prompts.",
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

        // Validate cron expression
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

        const def = store.add({ schedule, prompt, label })
        scheduler.start(def)

        return {
          content: [
            {
              type: "text" as const,
              text: `Cron created: ${def.id}\n  Schedule: ${def.schedule}\n  Prompt: ${def.prompt}${def.label ? `\n  Label: ${def.label}` : ""}`,
            },
          ],
        }
      }

      case "cron_delete": {
        const id = args?.id as string
        scheduler.stop(id)
        const removed = store.remove(id)

        return {
          content: [
            {
              type: "text" as const,
              text: removed
                ? `Cron ${id} deleted.`
                : `Cron ${id} not found.`,
            },
          ],
        }
      }

      case "cron_list": {
        const crons = store.list()
        if (crons.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No cron jobs configured." },
            ],
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
      }

      default:
        return {
          content: [
            { type: "text" as const, text: `Unknown tool: ${name}` },
          ],
          isError: true,
        }
    }
  })

  async function emitChannelEvent(
    content: string,
    meta: Record<string, string>,
  ): Promise<void> {
    await server.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    })
  }

  return { server, emitChannelEvent }
}
