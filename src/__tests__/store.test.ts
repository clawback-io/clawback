import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { CronStore } from "../cron/store.js"
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let dataDir: string

beforeEach(() => {
  dataDir = join(tmpdir(), `clawback-test-${crypto.randomUUID()}`)
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe("CronStore", () => {
  test("list returns empty array when no file exists", () => {
    const store = new CronStore(dataDir)
    expect(store.list()).toEqual([])
  })

  test("add creates a cron and persists it", () => {
    const store = new CronStore(dataDir)
    const def = store.add({ schedule: "* * * * *", prompt: "hello" })

    expect(def.id).toBeString()
    expect(def.id.length).toBe(12)
    expect(def.schedule).toBe("* * * * *")
    expect(def.prompt).toBe("hello")
    expect(def.createdAt).toBeString()

    // Verify persistence
    const loaded = store.list()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe(def.id)
  })

  test("add supports optional label", () => {
    const store = new CronStore(dataDir)
    const def = store.add({ schedule: "0 9 * * *", prompt: "test", label: "morning" })
    expect(def.label).toBe("morning")
  })

  test("add appends to existing crons", () => {
    const store = new CronStore(dataDir)
    store.add({ schedule: "* * * * *", prompt: "one" })
    store.add({ schedule: "0 * * * *", prompt: "two" })

    const list = store.list()
    expect(list).toHaveLength(2)
    expect(list[0].prompt).toBe("one")
    expect(list[1].prompt).toBe("two")
  })

  test("remove deletes a cron by id", () => {
    const store = new CronStore(dataDir)
    const def = store.add({ schedule: "* * * * *", prompt: "removeme" })

    expect(store.remove(def.id)).toBe(true)
    expect(store.list()).toHaveLength(0)
  })

  test("remove returns false for non-existent id", () => {
    const store = new CronStore(dataDir)
    expect(store.remove("nonexistent")).toBe(false)
  })

  test("load returns empty array for invalid JSON", () => {
    const store = new CronStore(dataDir)
    writeFileSync(join(dataDir, "crons.json"), "not json!")
    expect(store.load()).toEqual([])
  })

  test("load returns empty array for non-array JSON", () => {
    const store = new CronStore(dataDir)
    writeFileSync(join(dataDir, "crons.json"), '{"not": "array"}')
    expect(store.load()).toEqual([])
  })

  test("save creates directory if it doesn't exist", () => {
    const nestedDir = join(dataDir, "nested", "deep")
    const store = new CronStore(nestedDir)
    store.add({ schedule: "* * * * *", prompt: "test" })

    expect(existsSync(join(nestedDir, "crons.json"))).toBe(true)
  })

  test("save writes valid JSON", () => {
    const store = new CronStore(dataDir)
    store.add({ schedule: "0 9 * * *", prompt: "check" })

    const raw = readFileSync(join(dataDir, "crons.json"), "utf-8")
    const parsed = JSON.parse(raw)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].schedule).toBe("0 9 * * *")
  })

  test("data survives across store instances", () => {
    const store1 = new CronStore(dataDir)
    const def = store1.add({ schedule: "*/5 * * * *", prompt: "persist" })

    const store2 = new CronStore(dataDir)
    const list = store2.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(def.id)
    expect(list[0].prompt).toBe("persist")
  })
})
