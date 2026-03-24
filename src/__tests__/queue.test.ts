import { afterEach, describe, expect, mock, test } from "bun:test"
import { type EmitFn, EventQueue } from "../queue.js"

function makeEvent(id: string, meta: Record<string, string> = {}) {
  return {
    content: `event-${id}`,
    meta: { source: "test", id, ...meta },
  }
}

function makeQueue(
  emitFn: ReturnType<typeof mock>,
  opts: Partial<{ reminderDelayMs: number; timeoutMs: number }> = {},
) {
  return new EventQueue({
    emitFn,
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

  test("inflightMeta returns current event meta", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    expect(queue.inflightMeta).toBeNull()

    queue.enqueue(makeEvent("1", { remoteEventId: "evt_remote" }))
    await new Promise((r) => setTimeout(r, 10))

    expect(queue.inflightMeta?.remoteEventId).toBe("evt_remote")

    queue.ack()
    expect(queue.inflightMeta).toBeNull()
  })

  test("priority event jumps to front of queue", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    queue.enqueue(makeEvent("normal-1"))
    await new Promise((r) => setTimeout(r, 10))
    // normal-1 is inflight

    queue.enqueue(makeEvent("normal-2"))
    queue.enqueue(makeEvent("urgent", { priority: "priority" }))
    queue.enqueue(makeEvent("normal-3"))

    // urgent should be at front, then normal-2, then normal-3
    queue.ack()
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn.mock.calls[1][0]).toBe("event-urgent")

    queue.ack()
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn.mock.calls[2][0]).toBe("event-normal-2")

    queue.ack()
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn.mock.calls[3][0]).toBe("event-normal-3")
  })

  test("interrupt re-queues current event and dispatches immediately", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    queue.enqueue(makeEvent("working"))
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn.mock.calls[0][0]).toBe("event-working")
    expect(queue.busy).toBe(true)

    // Interrupt while "working" is inflight
    queue.enqueue(makeEvent("emergency", { priority: "interrupt" }))
    await new Promise((r) => setTimeout(r, 10))

    // Emergency should have dispatched, working should be re-queued
    expect(emitFn.mock.calls[1][0]).toBe("event-emergency")
    expect(queue.busy).toBe(true)

    // Ack the interrupt — "working" should resume
    queue.ack()
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn.mock.calls[2][0]).toBe("event-working")
  })

  test("interrupt when idle dispatches immediately like priority", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    queue.enqueue(makeEvent("interrupt-idle", { priority: "interrupt" }))
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn.mock.calls[0][0]).toBe("event-interrupt-idle")
  })

  test("interrupt preserves queue order after re-queue", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = makeQueue(emitFn)

    queue.enqueue(makeEvent("first"))
    await new Promise((r) => setTimeout(r, 10))
    // first is inflight

    queue.enqueue(makeEvent("second"))
    queue.enqueue(makeEvent("third"))

    // Interrupt — first gets re-queued to front
    queue.enqueue(makeEvent("urgent", { priority: "interrupt" }))
    await new Promise((r) => setTimeout(r, 10))

    expect(emitFn.mock.calls[1][0]).toBe("event-urgent")

    // After ack: first, second, third
    queue.ack()
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn.mock.calls[2][0]).toBe("event-first")

    queue.ack()
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn.mock.calls[3][0]).toBe("event-second")

    queue.ack()
    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn.mock.calls[4][0]).toBe("event-third")
  })
})
