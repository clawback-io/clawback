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
  test("loads a valid config with remote and connectionToken", () => {
    const configPath = join(tmpDir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        remote: "wss://clawback.fly.dev/ws",
        connectionToken: "cbt_abc123",
      }),
    )
    process.env.CLAWBACK_CONFIG = configPath

    const config = loadConfig()
    expect(config.remote).toBe("wss://clawback.fly.dev/ws")
    expect(config.connectionToken).toBe("cbt_abc123")
    expect(config.dataDir).toBeString()
  })

  test("accepts ws:// URLs for local development", () => {
    const configPath = join(tmpDir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        remote: "ws://localhost:3000/ws",
        connectionToken: "cbt_dev",
      }),
    )
    process.env.CLAWBACK_CONFIG = configPath

    const config = loadConfig()
    expect(config.remote).toBe("ws://localhost:3000/ws")
  })

  test("allows custom dataDir", () => {
    const configPath = join(tmpDir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        remote: "wss://example.com/ws",
        connectionToken: "cbt_abc",
        dataDir: "/tmp/custom-clawback",
      }),
    )
    process.env.CLAWBACK_CONFIG = configPath

    const config = loadConfig()
    expect(config.dataDir).toBe("/tmp/custom-clawback")
  })

  test("sessionMessaging defaults to false when not specified", () => {
    const configPath = join(tmpDir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        remote: "wss://clawback.fly.dev/ws",
        connectionToken: "cbt_abc123",
      }),
    )
    process.env.CLAWBACK_CONFIG = configPath

    const config = loadConfig()
    expect(config.sessionMessaging).toBe(false)
  })

  test("notifications defaults to false when not specified", () => {
    const configPath = join(tmpDir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        remote: "wss://clawback.fly.dev/ws",
        connectionToken: "cbt_abc123",
      }),
    )
    process.env.CLAWBACK_CONFIG = configPath

    const config = loadConfig()
    expect(config.notifications).toBe(false)
  })

  test("sessionMessaging and notifications can be explicitly set", () => {
    const configPath = join(tmpDir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        remote: "wss://clawback.fly.dev/ws",
        connectionToken: "cbt_abc123",
        sessionMessaging: false,
        notifications: true,
      }),
    )
    process.env.CLAWBACK_CONFIG = configPath

    const config = loadConfig()
    expect(config.sessionMessaging).toBe(false)
    expect(config.notifications).toBe(true)
  })
})
