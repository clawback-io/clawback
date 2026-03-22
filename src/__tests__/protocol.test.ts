import { describe, expect, test } from "bun:test"
import { encodeClientMessage, parseServerMessage } from "../ws/protocol.js"

describe("parseServerMessage", () => {
  test("parses event message", () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: "event",
        id: "evt_123",
        content: "PR opened",
        meta: { source: "webhook", path: "/github" },
      }),
    )
    expect(msg).toEqual({
      type: "event",
      id: "evt_123",
      content: "PR opened",
      meta: { source: "webhook", path: "/github" },
    })
  })

  test("parses ping message", () => {
    const msg = parseServerMessage(JSON.stringify({ type: "ping" }))
    expect(msg).toEqual({ type: "ping" })
  })

  test("parses response message", () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: "response",
        requestId: "req_1",
        data: { id: "cron_abc", schedule: "0 9 * * *" },
      }),
    )
    expect(msg).toEqual({
      type: "response",
      requestId: "req_1",
      data: { id: "cron_abc", schedule: "0 9 * * *" },
    })
  })

  test("parses response with error", () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: "response",
        requestId: "req_2",
        data: null,
        error: "not found",
      }),
    )
    expect(msg?.type).toBe("response")
    if (msg?.type === "response") {
      expect(msg.error).toBe("not found")
    }
  })

  test("returns null for invalid JSON", () => {
    expect(parseServerMessage("not json")).toBeNull()
  })

  test("returns null for non-object", () => {
    expect(parseServerMessage('"hello"')).toBeNull()
    expect(parseServerMessage("42")).toBeNull()
    expect(parseServerMessage("null")).toBeNull()
  })

  test("returns null for object without type", () => {
    expect(parseServerMessage(JSON.stringify({ id: "123" }))).toBeNull()
  })

  test("returns null for object with non-string type", () => {
    expect(parseServerMessage(JSON.stringify({ type: 42 }))).toBeNull()
  })
})

describe("encodeClientMessage", () => {
  test("encodes ack message", () => {
    const json = encodeClientMessage({
      type: "ack",
      eventId: "evt_123",
      summary: "Reviewed PR",
    })
    expect(JSON.parse(json)).toEqual({
      type: "ack",
      eventId: "evt_123",
      summary: "Reviewed PR",
    })
  })

  test("encodes pong message", () => {
    const json = encodeClientMessage({ type: "pong" })
    expect(JSON.parse(json)).toEqual({ type: "pong" })
  })

  test("encodes cron_create message", () => {
    const json = encodeClientMessage({
      type: "cron_create",
      requestId: "req_1",
      schedule: "0 9 * * *",
      prompt: "/catchup",
      label: "Morning catchup",
    })
    const parsed = JSON.parse(json)
    expect(parsed.type).toBe("cron_create")
    expect(parsed.schedule).toBe("0 9 * * *")
    expect(parsed.prompt).toBe("/catchup")
    expect(parsed.label).toBe("Morning catchup")
  })

  test("encodes cron_delete message", () => {
    const json = encodeClientMessage({
      type: "cron_delete",
      requestId: "req_2",
      cronId: "abc123",
    })
    expect(JSON.parse(json)).toEqual({
      type: "cron_delete",
      requestId: "req_2",
      cronId: "abc123",
    })
  })

  test("encodes cron_list message", () => {
    const json = encodeClientMessage({
      type: "cron_list",
      requestId: "req_3",
    })
    expect(JSON.parse(json)).toEqual({
      type: "cron_list",
      requestId: "req_3",
    })
  })
})
