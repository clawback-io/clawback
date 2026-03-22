import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../config.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `clawback-config-test-${crypto.randomUUID()}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAWBACK_CONFIG
})

describe("loadConfig", () => {
  test("returns defaults when config file does not exist", () => {
    process.env.CLAWBACK_CONFIG = join(tmpDir, "nonexistent.json")
    const config = loadConfig()

    expect(config.webhookPort).toBe(18788)
    expect(config.webhookHost).toBe("127.0.0.1")
    expect(config.skills).toEqual({})
    expect(config.dataDir).toBeString()
  })

  test("loads and parses a valid config file", () => {
    const configPath = join(tmpDir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        webhookPort: 9999,
        webhookHost: "0.0.0.0",
        skills: { "/github": "/review" },
      }),
    )
    process.env.CLAWBACK_CONFIG = configPath

    const config = loadConfig()
    expect(config.webhookPort).toBe(9999)
    expect(config.webhookHost).toBe("0.0.0.0")
    expect(config.skills).toEqual({ "/github": "/review" })
  })

  test("applies defaults for missing fields", () => {
    const configPath = join(tmpDir, "config.json")
    writeFileSync(configPath, JSON.stringify({ webhookPort: 3000 }))
    process.env.CLAWBACK_CONFIG = configPath

    const config = loadConfig()
    expect(config.webhookPort).toBe(3000)
    expect(config.webhookHost).toBe("127.0.0.1")
    expect(config.skills).toEqual({})
  })

  test("accepts empty object and returns all defaults", () => {
    const configPath = join(tmpDir, "config.json")
    writeFileSync(configPath, "{}")
    process.env.CLAWBACK_CONFIG = configPath

    const config = loadConfig()
    expect(config.webhookPort).toBe(18788)
    expect(config.webhookHost).toBe("127.0.0.1")
    expect(config.skills).toEqual({})
  })
})
