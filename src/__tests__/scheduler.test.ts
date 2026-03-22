import { beforeEach, describe, expect, mock, test } from "bun:test"
import { CronScheduler } from "../cron/scheduler.js"
import type { CronDefinition } from "../cron/types.js"
import { EventQueue } from "../queue.js"

function makeDef(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    id: overrides.id ?? crypto.randomUUID().slice(0, 12),
    schedule: overrides.schedule ?? "0 0 1 1 *", // Jan 1 midnight (won't fire during test)
    prompt: overrides.prompt ?? "test prompt",
    label: overrides.label,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  }
}

function makeQueue(): EventQueue {
  return new EventQueue({ emitFn: mock(async () => {}) })
}

describe("CronScheduler", () => {
  let eventQueue: EventQueue

  beforeEach(() => {
    eventQueue = makeQueue()
  })

  test("start registers a job and stop removes it", () => {
    const scheduler = new CronScheduler(eventQueue)
    const def = makeDef()

    scheduler.start(def)
    expect(scheduler.stop(def.id)).toBe(true)
  })

  test("stop returns false for unknown id", () => {
    const scheduler = new CronScheduler(eventQueue)
    expect(scheduler.stop("nonexistent")).toBe(false)
  })

  test("startAll registers multiple jobs", () => {
    const scheduler = new CronScheduler(eventQueue)
    const defs = [makeDef(), makeDef(), makeDef()]

    scheduler.startAll(defs)

    for (const def of defs) {
      expect(scheduler.stop(def.id)).toBe(true)
    }
  })

  test("stopAll clears all jobs", () => {
    const scheduler = new CronScheduler(eventQueue)
    const defs = [makeDef(), makeDef()]

    scheduler.startAll(defs)
    scheduler.stopAll()

    // All should be gone
    for (const def of defs) {
      expect(scheduler.stop(def.id)).toBe(false)
    }
  })

  test("start replaces existing job with same id", () => {
    const scheduler = new CronScheduler(eventQueue)
    const def = makeDef()

    scheduler.start(def)
    scheduler.start({ ...def, prompt: "updated" })

    // Should still have exactly one job for this id
    expect(scheduler.stop(def.id)).toBe(true)
    expect(scheduler.stop(def.id)).toBe(false)
  })
})
