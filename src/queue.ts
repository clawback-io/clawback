export type EmitFn = (content: string, meta: Record<string, string>) => Promise<void>

export interface QueuedEvent {
  content: string
  meta: Record<string, string>
}

export interface EventQueueOptions {
  emitFn: EmitFn
  /** How long to wait before sending a reminder nudge (ms). Default: 120000 (2 min) */
  reminderDelayMs?: number
  /** How long to wait before giving up on ack and moving on (ms). Default: 300000 (5 min) */
  timeoutMs?: number
}

const DEFAULT_REMINDER_DELAY_MS = 120_000 // 2 minutes
const DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes

interface InflightContext {
  meta: Record<string, string>
  dispatchedAt: string
  queueDepth: number
}

export class EventQueue {
  private queue: QueuedEvent[] = []
  private inflight = false
  private inflightCtx: InflightContext | null = null
  private reminderTimer: ReturnType<typeof setTimeout> | null = null
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null
  private reminderSent = false

  private emitFn: EmitFn
  private reminderDelayMs: number
  private timeoutMs: number

  constructor(opts: EventQueueOptions) {
    this.emitFn = opts.emitFn
    this.reminderDelayMs = opts.reminderDelayMs ?? DEFAULT_REMINDER_DELAY_MS
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get pending(): number {
    return this.queue.length
  }

  get busy(): boolean {
    return this.inflight
  }

  /** Meta of the currently inflight event (if any). Used to extract remoteEventId for acks. */
  get inflightMeta(): Record<string, string> | null {
    return this.inflightCtx?.meta ?? null
  }

  enqueue(event: QueuedEvent): void {
    this.queue.push(event)
    console.error(
      `[clawback] Event queued (${this.queue.length} pending, inflight=${this.inflight})`,
    )
    this.tryDispatch()
  }

  /** Called when Claude acknowledges it finished processing the current event. */
  ack(_summary?: string): void {
    if (!this.inflight) {
      console.error("[clawback] Ack received but nothing inflight — ignoring")
      return
    }
    console.error("[clawback] Ack received, dispatching next")
    this.clearTimers()
    this.inflight = false
    this.inflightCtx = null
    this.tryDispatch()
  }

  private tryDispatch(): void {
    if (this.inflight || this.queue.length === 0) return

    const event = this.queue.shift()
    if (!event) return
    this.inflight = true
    this.reminderSent = false

    const queueDepth = this.queue.length

    this.inflightCtx = {
      meta: event.meta,
      dispatchedAt: new Date().toISOString(),
      queueDepth,
    }

    const meta = {
      ...event.meta,
      queueDepth: String(queueDepth),
    }

    console.error(`[clawback] Dispatching event (${queueDepth} remaining in queue)`)

    this.emitFn(event.content, meta).catch((err) => {
      console.error("[clawback] Event dispatch failed:", err)
      this.clearTimers()
      this.inflight = false
      this.inflightCtx = null
      this.tryDispatch()
    })

    this.startTimers()
  }

  private startTimers(): void {
    this.reminderTimer = setTimeout(() => {
      this.sendReminder()
    }, this.reminderDelayMs)

    this.timeoutTimer = setTimeout(() => {
      this.onTimeout()
    }, this.timeoutMs)
  }

  private clearTimers(): void {
    if (this.reminderTimer) {
      clearTimeout(this.reminderTimer)
      this.reminderTimer = null
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
    }
  }

  private sendReminder(): void {
    if (!this.inflight || this.reminderSent) return
    this.reminderSent = true

    const waiting = this.queue.length
    if (waiting === 0) return

    console.error(`[clawback] Sending ack reminder (${waiting} events waiting)`)

    this.emitFn(
      `Reminder: when you finish your current task, call the event_ack tool. ${waiting} event${waiting === 1 ? "" : "s"} waiting. Do NOT stop what you are doing — just call event_ack when you are naturally done.`,
      {
        source: "system",
        type: "ack_reminder",
        queueDepth: String(waiting),
      },
    ).catch((err) => {
      console.error("[clawback] Reminder notification failed:", err)
    })
  }

  private onTimeout(): void {
    if (!this.inflight) return
    console.error(`[clawback] Ack timeout (${this.timeoutMs}ms) — moving on to next event`)
    this.clearTimers()
    this.inflight = false
    this.inflightCtx = null
    this.tryDispatch()
  }

  shutdown(): void {
    this.clearTimers()
    this.queue.length = 0
    this.inflight = false
    this.inflightCtx = null
  }
}
