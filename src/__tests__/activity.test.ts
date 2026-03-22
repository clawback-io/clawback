import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ActivityLog, type ActivityEntry } from "../activity.js"

let dataDir: string

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: overrides.id ?? `evt_${crypto.randomUUID().slice(0, 8)}`,
    source: overrides.source ?? "webhook",
    path: overrides.path ?? "/test",
    skill: overrides.skill ?? "",
    cronId: overrides.cronId ?? "",
    summary: overrides.summary ?? "test summary",
    dispatchedAt: overrides.dispatchedAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt ?? new Date().toISOString(),
    durationMs: overrides.durationMs ?? 1000,
    queueDepth: overrides.queueDepth ?? 0,
    timedOut: overrides.timedOut ?? false,
  }
}

beforeEach(() => {
  dataDir = join(tmpdir(), `clawback-test-${crypto.randomUUID()}`)
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe("ActivityLog", () => {
  test("list returns empty array when no file exists", () => {
    const log = new ActivityLog(dataDir)
    expect(log.list()).toEqual([])
  })

  test("append creates entry and persists it", () => {
    const log = new ActivityLog(dataDir)
    const entry = makeEntry({ summary: "reviewed PR" })
    log.append(entry)

    const entries = log.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toBe("reviewed PR")
    expect(entries[0].id).toBe(entry.id)
  })

  test("append accumulates entries", () => {
    const log = new ActivityLog(dataDir)
    log.append(makeEntry({ summary: "first" }))
    log.append(makeEntry({ summary: "second" }))
    log.append(makeEntry({ summary: "third" }))

    const entries = log.list()
    expect(entries).toHaveLength(3)
    expect(entries.map((e) => e.summary)).toEqual(["first", "second", "third"])
  })

  test("data survives across instances", () => {
    const log1 = new ActivityLog(dataDir)
    log1.append(makeEntry({ summary: "persistent" }))

    const log2 = new ActivityLog(dataDir)
    const entries = log2.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toBe("persistent")
  })

  test("caps at 500 entries, keeping most recent", () => {
    const log = new ActivityLog(dataDir)

    for (let i = 0; i < 510; i++) {
      log.append(makeEntry({ summary: `entry-${i}` }))
    }

    const entries = log.list()
    expect(entries).toHaveLength(500)
    // First entry should be entry-10 (oldest 10 trimmed)
    expect(entries[0].summary).toBe("entry-10")
    // Last entry should be entry-509
    expect(entries[499].summary).toBe("entry-509")
  })

  test("load returns empty array for invalid JSON", () => {
    const log = new ActivityLog(dataDir)
    writeFileSync(join(dataDir, "activity.json"), "not json!")
    expect(log.load()).toEqual([])
  })

  test("load returns empty array for non-array JSON", () => {
    const log = new ActivityLog(dataDir)
    writeFileSync(join(dataDir, "activity.json"), '{"not": "array"}')
    expect(log.load()).toEqual([])
  })

  test("creates directory if it doesn't exist", () => {
    const nestedDir = join(dataDir, "nested", "deep")
    const log = new ActivityLog(nestedDir)
    log.append(makeEntry())

    const entries = log.list()
    expect(entries).toHaveLength(1)
  })

  test("stores all fields correctly", () => {
    const log = new ActivityLog(dataDir)
    const entry = makeEntry({
      source: "cron",
      path: "",
      skill: "",
      cronId: "abc123",
      summary: "ran morning catchup",
      durationMs: 45000,
      queueDepth: 3,
      timedOut: false,
    })
    log.append(entry)

    const stored = log.list()[0]
    expect(stored.source).toBe("cron")
    expect(stored.cronId).toBe("abc123")
    expect(stored.summary).toBe("ran morning catchup")
    expect(stored.durationMs).toBe(45000)
    expect(stored.queueDepth).toBe(3)
    expect(stored.timedOut).toBe(false)
  })
})
