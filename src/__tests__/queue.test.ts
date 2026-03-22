import { afterEach, describe, expect, mock, test } from "bun:test"
import { EventQueue, type EmitFn } from "../queue.js"

function makeEvent(id: string) {
  return {
    content: `event-${id}`,
    meta: { source: "test", id },
  }
}

describe("EventQueue", () => {
  let queue: EventQueue

  afterEach(() => {
    queue?.shutdown()
  })

  test("dispatches immediately when idle", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({ emitFn })

    queue.enqueue(makeEvent("1"))

    // Give the async emitFn a tick to resolve
    await new Promise((r) => setTimeout(r, 10))

    expect(emitFn).toHaveBeenCalledTimes(1)
    expect(emitFn.mock.calls[0][0]).toBe("event-1")
  })

  test("holds second event until ack", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({ emitFn })

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))

    await new Promise((r) => setTimeout(r, 10))

    // Only first event dispatched
    expect(emitFn).toHaveBeenCalledTimes(1)
    expect(emitFn.mock.calls[0][0]).toBe("event-1")

    // Ack releases the next
    queue.ack()
    await new Promise((r) => setTimeout(r, 10))

    expect(emitFn).toHaveBeenCalledTimes(2)
    expect(emitFn.mock.calls[1][0]).toBe("event-2")
  })

  test("ack with nothing inflight is a no-op", () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({ emitFn })

    // Should not throw
    queue.ack()
    expect(emitFn).toHaveBeenCalledTimes(0)
  })

  test("includes queueDepth in meta", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({ emitFn })

    // First event dispatches immediately (queue idle), so queueDepth = 0
    queue.enqueue(makeEvent("1"))
    // These two arrive while first is inflight
    queue.enqueue(makeEvent("2"))
    queue.enqueue(makeEvent("3"))

    await new Promise((r) => setTimeout(r, 10))

    const meta = emitFn.mock.calls[0][1]
    expect(meta.queueDepth).toBe("0")

    // Ack → second dispatches with 1 remaining
    queue.ack()
    await new Promise((r) => setTimeout(r, 10))

    const meta2 = emitFn.mock.calls[1][1]
    expect(meta2.queueDepth).toBe("1")

    // Ack → third dispatches with 0 remaining
    queue.ack()
    await new Promise((r) => setTimeout(r, 10))

    const meta3 = emitFn.mock.calls[2][1]
    expect(meta3.queueDepth).toBe("0")
  })

  test("pending returns queued count", () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({ emitFn })

    expect(queue.pending).toBe(0)

    queue.enqueue(makeEvent("1"))
    // First event is dispatched immediately, queue is empty
    expect(queue.pending).toBe(0)

    queue.enqueue(makeEvent("2"))
    expect(queue.pending).toBe(1)

    queue.enqueue(makeEvent("3"))
    expect(queue.pending).toBe(2)
  })

  test("busy reflects inflight state", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({ emitFn })

    expect(queue.busy).toBe(false)

    queue.enqueue(makeEvent("1"))
    await new Promise((r) => setTimeout(r, 10))

    expect(queue.busy).toBe(true)

    queue.ack()
    expect(queue.busy).toBe(false)
  })

  test("timeout auto-advances after delay", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({
      emitFn,
      reminderDelayMs: 50,
      timeoutMs: 150,
    })

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))

    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn).toHaveBeenCalledTimes(1)

    // Wait for timeout to fire (150ms + buffer)
    await new Promise((r) => setTimeout(r, 200))

    // Reminder emits a notification, then timeout advances to event-2
    // emitFn calls: event-1, reminder, event-2
    expect(emitFn).toHaveBeenCalledTimes(3)
    expect(emitFn.mock.calls[2][0]).toBe("event-2")
  })

  test("reminder fires but does not advance queue", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({
      emitFn,
      reminderDelayMs: 50,
      timeoutMs: 5000, // long timeout so it doesn't interfere
    })

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))

    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn).toHaveBeenCalledTimes(1)

    // Wait for reminder (50ms + buffer)
    await new Promise((r) => setTimeout(r, 100))

    // Reminder sent but event-2 NOT dispatched yet
    expect(emitFn).toHaveBeenCalledTimes(2)

    const reminderContent = emitFn.mock.calls[1][0]
    expect(reminderContent).toContain("event_ack")
    expect(reminderContent).toContain("Do NOT stop")

    const reminderMeta = emitFn.mock.calls[1][1]
    expect(reminderMeta.type).toBe("ack_reminder")

    // Still inflight — event-2 waiting
    expect(queue.busy).toBe(true)
    expect(queue.pending).toBe(1)
  })

  test("reminder skipped when no events queued", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({
      emitFn,
      reminderDelayMs: 50,
      timeoutMs: 5000,
    })

    // Single event, nothing waiting behind it
    queue.enqueue(makeEvent("1"))

    await new Promise((r) => setTimeout(r, 100))

    // Only the event itself, no reminder (nothing queued)
    expect(emitFn).toHaveBeenCalledTimes(1)
  })

  test("ack cancels pending reminder and timeout", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({
      emitFn,
      reminderDelayMs: 100,
      timeoutMs: 200,
    })

    queue.enqueue(makeEvent("1"))
    await new Promise((r) => setTimeout(r, 10))

    // Ack before reminder fires
    queue.ack()

    // Wait past both reminder and timeout durations
    await new Promise((r) => setTimeout(r, 300))

    // Only the original event, no reminder or timeout-triggered dispatch
    expect(emitFn).toHaveBeenCalledTimes(1)
  })

  test("emit failure releases lock and dispatches next", async () => {
    let callCount = 0
    const emitFn = mock<EmitFn>(async () => {
      callCount++
      if (callCount === 1) throw new Error("emit failed")
    })
    queue = new EventQueue({ emitFn })

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))

    // Wait for the failed emit to resolve and retry
    await new Promise((r) => setTimeout(r, 50))

    // First call failed, second should have been dispatched
    expect(emitFn).toHaveBeenCalledTimes(2)
    expect(emitFn.mock.calls[1][0]).toBe("event-2")
  })

  test("shutdown clears queue and timers", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({
      emitFn,
      reminderDelayMs: 50,
      timeoutMs: 100,
    })

    queue.enqueue(makeEvent("1"))
    queue.enqueue(makeEvent("2"))
    queue.enqueue(makeEvent("3"))

    await new Promise((r) => setTimeout(r, 10))
    expect(emitFn).toHaveBeenCalledTimes(1)

    queue.shutdown()

    expect(queue.pending).toBe(0)
    expect(queue.busy).toBe(false)

    // Wait past timeout — nothing should fire
    await new Promise((r) => setTimeout(r, 150))
    expect(emitFn).toHaveBeenCalledTimes(1)
  })

  test("processes full sequence with acks", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    queue = new EventQueue({ emitFn })

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

    // Verify order
    expect(emitFn.mock.calls[0][0]).toBe("event-a")
    expect(emitFn.mock.calls[1][0]).toBe("event-b")
    expect(emitFn.mock.calls[2][0]).toBe("event-c")
  })
})
