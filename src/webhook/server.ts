import type { EmitFn } from "../cron/scheduler.js"

const MAX_BODY_SIZE = 256 * 1024 // 256KB
const BATCH_DELAY_MS = 5000 // Wait 5s of quiet before flushing

interface QueuedEvent {
  content: string
  meta: Record<string, string>
}

function findSkill(
  pathname: string,
  skills: Record<string, string>,
): string | null {
  if (skills[pathname]) return skills[pathname]
  let best: string | null = null
  let bestLen = 0
  for (const prefix of Object.keys(skills)) {
    if (pathname.startsWith(prefix) && prefix.length > bestLen) {
      best = skills[prefix]
      bestLen = prefix.length
    }
  }
  return best
}

export interface WebhookServerOptions {
  port: number
  host: string
  emitFn: EmitFn
  skills: Record<string, string>
}

export function startWebhookServer(opts: WebhookServerOptions) {
  const { port, host, emitFn, skills } = opts

  const queue: QueuedEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  async function flush() {
    flushTimer = null
    if (queue.length === 0) return

    const events = queue.splice(0)

    if (events.length === 1) {
      // Single event — send as-is
      const e = events[0]
      try {
        await emitFn(e.content, e.meta)
      } catch (err) {
        console.error("[clawback] Webhook notification failed:", err)
      }
    } else {
      // Multiple events — batch into one notification
      const parts = events.map((e, i) => {
        const header = `--- Event ${i + 1}/${events.length} [${e.meta.path}] ---`
        return `${header}\n${e.content}`
      })
      const content = parts.join("\n\n")

      try {
        await emitFn(content, {
          source: "webhook",
          path: "batch",
          method: "POST",
          contentType: "mixed",
          skill: "",
          truncated: "false",
          eventCount: String(events.length),
          timestamp: new Date().toISOString(),
        })
      } catch (err) {
        console.error("[clawback] Batch webhook notification failed:", err)
      }
    }
  }

  function enqueue(event: QueuedEvent) {
    queue.push(event)
    // Reset the debounce timer on each new event
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, BATCH_DELAY_MS)
    console.error(
      `[clawback] Queued webhook (${queue.length} pending, flushing in ${BATCH_DELAY_MS}ms)`,
    )
  }

  const server = Bun.serve({
    port,
    hostname: host,

    async fetch(req) {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 })
      }

      const url = new URL(req.url)
      const contentType = req.headers.get("content-type") ?? "unknown"

      let body = await req.text()
      let truncated = false
      if (body.length > MAX_BODY_SIZE) {
        const originalSize = body.length
        body = body.slice(0, MAX_BODY_SIZE)
        body += `\n[truncated: original size was ${originalSize} bytes]`
        truncated = true
      }

      const skill = findSkill(url.pathname, skills)
      const content = skill
        ? `${skill}\n\nContext:\n${body}`
        : body

      enqueue({
        content,
        meta: {
          source: "webhook",
          path: url.pathname,
          method: req.method,
          contentType,
          skill: skill ?? "",
          truncated: String(truncated),
          timestamp: new Date().toISOString(),
        },
      })

      return new Response("accepted", { status: 200 })
    },
  })

  console.error(`[clawback] Webhook server listening on ${host}:${port}`)
  return server
}
