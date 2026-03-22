import { afterEach, describe, expect, mock, test } from "bun:test"
import type { EmitFn } from "../cron/scheduler.js"
import { findSkill, startWebhookServer } from "../webhook/server.js"

describe("findSkill", () => {
  test("returns exact match", () => {
    expect(findSkill("/github", { "/github": "/review" })).toBe("/review")
  })

  test("returns null when no match", () => {
    expect(findSkill("/unknown", { "/github": "/review" })).toBeNull()
  })

  test("returns longest prefix match", () => {
    const skills = {
      "/api": "generic",
      "/api/deploy": "deploy-handler",
    }
    expect(findSkill("/api/deploy/prod", skills)).toBe("deploy-handler")
  })

  test("returns null for empty skills", () => {
    expect(findSkill("/anything", {})).toBeNull()
  })

  test("matches prefix even without exact entry", () => {
    expect(findSkill("/github/push", { "/github": "/review" })).toBe("/review")
  })
})

describe("startWebhookServer", () => {
  let server: ReturnType<typeof startWebhookServer> | null = null

  afterEach(() => {
    if (server) {
      server.stop()
      server = null
    }
  })

  test("returns 405 for GET requests", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    server = startWebhookServer({
      port: 0, // random available port
      host: "127.0.0.1",
      emitFn,
      skills: {},
    })

    const res = await fetch(`http://127.0.0.1:${server.port}`, { method: "GET" })
    expect(res.status).toBe(405)
  })

  test("returns 200 for POST requests", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    server = startWebhookServer({
      port: 0,
      host: "127.0.0.1",
      emitFn,
      skills: {},
    })

    const res = await fetch(`http://127.0.0.1:${server.port}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("accepted")
  })

  test("emits event after flush delay", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    server = startWebhookServer({
      port: 0,
      host: "127.0.0.1",
      emitFn,
      skills: {},
    })

    await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"key":"value"}',
    })

    // Wait for debounce flush (5s + buffer)
    await new Promise((r) => setTimeout(r, 5500))

    expect(emitFn).toHaveBeenCalledTimes(1)
    const [content, meta] = emitFn.mock.calls[0]
    expect(content).toBe('{"key":"value"}')
    expect(meta.source).toBe("webhook")
    expect(meta.path).toBe("/hook")
    expect(meta.method).toBe("POST")
  }, 10000)

  test("prepends skill when matched", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    server = startWebhookServer({
      port: 0,
      host: "127.0.0.1",
      emitFn,
      skills: { "/github": "/review" },
    })

    await fetch(`http://127.0.0.1:${server.port}/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"pr":42}',
    })

    await new Promise((r) => setTimeout(r, 5500))

    expect(emitFn).toHaveBeenCalledTimes(1)
    const [content, meta] = emitFn.mock.calls[0]
    expect(content).toContain("/review")
    expect(content).toContain('{"pr":42}')
    expect(meta.skill).toBe("/review")
  }, 10000)

  test("batches multiple events within flush window", async () => {
    const emitFn = mock<EmitFn>(async () => {})
    server = startWebhookServer({
      port: 0,
      host: "127.0.0.1",
      emitFn,
      skills: {},
    })

    // Send 3 events rapidly
    for (let i = 0; i < 3; i++) {
      await fetch(`http://127.0.0.1:${server.port}/test`, {
        method: "POST",
        body: `event-${i}`,
      })
    }

    await new Promise((r) => setTimeout(r, 5500))

    expect(emitFn).toHaveBeenCalledTimes(1)
    const [content, meta] = emitFn.mock.calls[0]
    expect(content).toContain("Event 1/3")
    expect(content).toContain("Event 2/3")
    expect(content).toContain("Event 3/3")
    expect(meta.eventCount).toBe("3")
    expect(meta.path).toBe("batch")
  }, 10000)
})
