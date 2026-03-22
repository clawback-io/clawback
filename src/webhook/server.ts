import type { EventQueue, QueuedEvent } from "../queue.js"

const MAX_BODY_SIZE = 256 * 1024 // 256KB
const BATCH_DELAY_MS = 5000 // Wait 5s of quiet before flushing

export function findSkill(pathname: string, skills: Record<string, string>): string | null {
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
  eventQueue: EventQueue
  skills: Record<string, string>
}

export function startWebhookServer(opts: WebhookServerOptions) {
  const { port, host, eventQueue, skills } = opts

  // Batch incoming webhooks with a 5s debounce before pushing to the event queue.
  // This collapses rapid-fire webhooks (e.g., a burst of GitHub events) into one queued event.
  const pending: QueuedEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flush() {
    flushTimer = null
    if (pending.length === 0) return

    const events = pending.splice(0)

    if (events.length === 1) {
      eventQueue.enqueue(events[0])
    } else {
      // Batch multiple webhooks into a single queued event
      const parts = events.map((e, i) => {
        const header = `--- Event ${i + 1}/${events.length} [${e.meta.path}] ---`
        return `${header}\n${e.content}`
      })
      eventQueue.enqueue({
        content: parts.join("\n\n"),
        meta: {
          source: "webhook",
          path: "batch",
          method: "POST",
          contentType: "mixed",
          skill: "",
          truncated: "false",
          eventCount: String(events.length),
          timestamp: new Date().toISOString(),
        },
      })
    }
  }

  function enqueue(event: QueuedEvent) {
    pending.push(event)
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, BATCH_DELAY_MS)
    console.error(
      `[clawback] Webhook queued (${pending.length} pending, flushing in ${BATCH_DELAY_MS}ms)`,
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
      const content = skill ? `${skill}\n\nContext:\n${body}` : body

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
