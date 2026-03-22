import { afterEach, describe, expect, mock, test } from "bun:test"
import { EventQueue, type EmitFn } from "../queue.js"
import type { ActivityLog, ActivityEntry } from "../activity.js"

function makeEvent(id: string, meta: Record<string, string> = {}) {
  return {
    content: `event-${id}`,
    meta: { source: "test", id, ...meta },
  }
}

function mockActivityLog() {
  const entries: ActivityEntry[] = []
  const log = {
    entries,
    load: () => entries,
    list: () => entries,
    append: (entry: ActivityEntry) => { entries.push(entry) },
  } as unknown as ActivityLog & { entries: ActivityEntry[] }
  return log
}

function makeQueue(
  emitFn: ReturnType<typeof mock>,
  opts: Partial<{ reminderDelayMs: number; timeoutMs: number; activityLog: ReturnType<typeof mockActivityLog> }> = {},
) {
  return new EventQueue({
    emitFn,
    activityLog: opts.activityLog ?? mockActivityLog(),
    reminderDelayMs: opts.reminderDelayMs,
    timeoutMs: opts.timeoutMs,
  })
}

describe("EventQueue", () => {
  let queue: EventQueue

  afterEach(() => {
    queue?.shutdown()
  })

  test("dispatches immediately when idle", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    queue.enqueue(makeEvent("1"))

    await new Promise((r) => setTimeout(r, 10))

    expect(emitFn).toHaveBeenCalledTimes(1)
    expect(emitFn.mock.calls[0][0]).toBe("event-1")
  })

  test("holds second event until ack", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))

    await new Promise((r) => setTimeout(r, 10))

    expect(emitFn).toHaveBeenCalledTimes(1)
    expect(emitFn.mock.calls[0][0]).toBe("event-1")

    queue.ack()
    await new Promise((r) => setTimeout(r, 10))

    expect(emitFn).toHaveBeenCalledTimes(2)
    expect(emitFn.mock.calls[1][0]).toBe("event-2")
  })

  test("ack with nothing inflight is a no-op", () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    queue.ack()
    expect(emitFn).toHaveBeenCalledTimes(0)
  })

  test("includes queueDepth in meta", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))
    queue.enqueue(makeEvent("3"))

    await new Promise((r) => setTimeout(r, 10))

    const meta = emitFn.mock.calls[0][1]
    expect(meta.queueDepth).toBe("0")

    queue.ack()
    await new Promise((r) => setTimeout(r, 10))

    const meta2 = emitFn.mock.calls[1][1]
    expect(meta2.queueDepth).toBe("1")

    queue.ack()
    await new Promise((r) => setTimeout(r, 10))

    const meta3 = emitFn.mock.calls[2][1]
    expect(meta3.queueDepth).toBe("0")
  })

  test("pending returns queued count", () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    expect(queue.pending).toBe(0)

    queue.enqueue(makeEvent("1"))
    expect(queue.pending).toBe(0)

    queue.enqueue(makeEvent("2"))
    expect(queue.pending).toBe(1)

    queue.enqueue(makeEvent("3"))
    expect(queue.pending).toBe(2)
  })

  test("busy reflects inflight state", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    expect(queue.busy).toBe(false)

    queue.enqueue(makeEvent("1"))
    await new Promise((r) => setTimeout(r, 10))

    expect(queue.busy).toBe(true)

    queue.ack()
    expect(queue.busy).toBe(false)
  })

  test("timeout auto-advances after delay", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn, { reminderDelayMs: 50, timeoutMs: 150 })

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))

    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn).toHaveBeenCalledTimes(1)

    await new Promise((r) => setTimeout(r, 200))

    expect(emitFn).toHaveBeenCalledTimes(3)
    expect(emitFn.mock.calls[2][0]).toBe("event-2")
  })

  test("reminder fires but does not advance queue", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn, { reminderDelayMs: 50, timeoutMs: 5000 })

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))

    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn).toHaveBeenCalledTimes(1)

    await new Promise((r) => setTimeout(r, 100))

    expect(emitFn).toHaveBeenCalledTimes(2)

    const reminderContent = emitFn.mock.calls[1][0]
    expect(reminderContent).toContain("event_ack")
    expect(reminderContent).toContain("Do NOT stop")

    const reminderMeta = emitFn.mock.calls[1][1]
    expect(reminderMeta.type).toBe("ack_reminder")

    expect(queue.busy).toBe(true)
    expect(queue.pending).toBe(1)
  })

  test("reminder skipped when no events queued", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn, { reminderDelayMs: 50, timeoutMs: 5000 })

    queue.enqueue(makeEvent("1"))

    await new Promise((r) => setTimeout(r, 100))

    expect(emitFn).toHaveBeenCalledTimes(1)
  })

  test("ack cancels pending reminder and timeout", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn, { reminderDelayMs: 100, timeoutMs: 200 })

    queue.enqueue(makeEvent("1"))
    await new Promise((r) => setTimeout(r, 10))

    queue.ack()

    await new Promise((r) => setTimeout(r, 300))

    expect(emitFn).toHaveBeenCalledTimes(1)
  })

  test("emit failure releases lock and dispatches next", async () => {
    let callCount = 0
    const emitFn = mock<EmitFn>(async () => {
      callCount++
      if (callCount === 1) throw new Error("emit failed")
    })
    queue = makeQueue(emitFn)

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))

    await new Promise((r) => setTimeout(r, 50))

    expect(emitFn).toHaveBeenCalledTimes(2)
    expect(emitFn.mock.calls[1][0]).toBe("event-2")
  })

  test("shutdown clears queue and timers", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn, { reminderDelayMs: 50, timeoutMs: 100 })

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))
    queue.enqueue(makeEvent("3"))

    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn).toHaveBeenCalledTimes(1)

    queue.shutdown()

    expect(queue.pending).toBe(0)
    expect(queue.busy).toBe(false)

    await new Promise((r) => setTimeout(r, 150))
    expect(emitFn).toHaveBeenCalledTimes(1)
  })

  test("processes full sequence with acks", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    queue.enqueue(makeEvent("a"))
    queue.enqueue(makeEvent("b"))
    queue.enqueue(makeEvent("c"))

    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn).toHaveBeenCalledTimes(1)

    queue.ack()
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn).toHaveBeenCalledTimes(2)

    queue.ack()
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn).toHaveBeenCalledTimes(3)

    queue.ack()
    expect(queue.busy).toBe(false)
    expect(queue.pending).toBe(0)

    expect(emitFn.mock.calls[0][0]).toBe("event-a")
    expect(emitFn.mock.calls[1][0]).toBe("event-b")
    expect(emitFn.mock.calls[2][0]).toBe("event-c")
  })
})

describe("EventQueue activity logging", () => {
  let queue: EventQueue

  afterEach(() => {
    queue?.shutdown()
  })

  test("ack records activity entry with summary", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    const log = mockActivityLog()
    queue = makeQueue(emitFn, { activityLog: log })

    queue.enqueue(makeEvent("1", { source: "webhook", path: "/github", skill: "/review" }))
    await new Promise((r) => setTimeout(r, 10))

    queue.ack("Reviewed PR #42")

    expect(log.entries).toHaveLength(1)
    const entry = log.entries[0]
    expect(entry.summary).toBe("Reviewed PR #42")
    expect(entry.source).toBe("webhook")
    expect(entry.path).toBe("/github")
    expect(entry.skill).toBe("/review")
    expect(entry.timedOut).toBe(false)
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    expect(entry.id).toMatch(/^evt_/)
    expect(entry.dispatchedAt).toBeTruthy()
    expect(entry.completedAt).toBeTruthy()
  })

  test("ack without summary records empty string", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    const log = mockActivityLog()
    queue = makeQueue(emitFn, { activityLog: log })

    queue.enqueue(makeEvent("1"))
    await new Promise((r) => setTimeout(r, 10))

    queue.ack()

    expect(log.entries).toHaveLength(1)
    expect(log.entries[0].summary).toBe("")
  })

  test("timeout records activity with timedOut=true", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    const log = mockActivityLog()
    queue = makeQueue(emitFn, { activityLog: log, reminderDelayMs: 5000, timeoutMs: 50 })

    queue.enqueue(makeEvent("1"))
    await new Promise((r) => setTimeout(r, 100))

    expect(log.entries).toHaveLength(1)
    expect(log.entries[0].timedOut).toBe(true)
    expect(log.entries[0].summary).toBe("")
  })

  test("records queueDepth at dispatch time", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    const log = mockActivityLog()
    queue = makeQueue(emitFn, { activityLog: log })

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))
    queue.enqueue(makeEvent("3"))

    await new Promise((r) => setTimeout(r, 10))

    queue.ack("first")
    await new Promise((r) => setTimeout(r, 10))

    queue.ack("second")
    await new Promise((r) => setTimeout(r, 10))

    queue.ack("third")

    expect(log.entries).toHaveLength(3)
    expect(log.entries[0].queueDepth).toBe(0) // dispatched immediately, nothing behind it yet
    expect(log.entries[1].queueDepth).toBe(1) // 1 remaining when dispatched
    expect(log.entries[2].queueDepth).toBe(0)
  })

  test("records cronId for cron events", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    const log = mockActivityLog()
    queue = makeQueue(emitFn, { activityLog: log })

    queue.enqueue(makeEvent("1", { source: "cron", cronId: "abc123" }))
    await new Promise((r) => setTimeout(r, 10))

    queue.ack("ran catchup")

    expect(log.entries[0].cronId).toBe("abc123")
    expect(log.entries[0].source).toBe("cron")
  })

  test("multiple acks build up activity history", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    const log = mockActivityLog()
    queue = makeQueue(emitFn, { activityLog: log })

    queue.enqueue(makeEvent("a"))
    await new Promise((r) => setTimeout(r, 10))
    queue.ack("did A")

    queue.enqueue(makeEvent("b"))
    await new Promise((r) => setTimeout(r, 10))
    queue.ack("did B")

    queue.enqueue(makeEvent("c"))
    await new Promise((r) => setTimeout(r, 10))
    queue.ack("did C")

    expect(log.entries).toHaveLength(3)
    expect(log.entries.map((e) => e.summary)).toEqual(["did A", "did B", "did C"])
  })
})
