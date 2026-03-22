/** Messages sent from the remote server to the local plugin */
export type ServerMessage =
  | { type: "event"; id: string; content: string; meta: Record<string, string> }
  | { type: "ping" }
  | { type: "response"; requestId: string; data: unknown; error?: string }

/** Messages sent from the local plugin to the remote server */
export type ClientMessage =
  | { type: "ack"; eventId: string; summary: string }
  | { type: "pong" }
  | {
      type: "cron_create"
      requestId: string
      schedule: string
      prompt: string
      label?: string
    }
  | { type: "cron_delete"; requestId: string; cronId: string }
  | { type: "cron_list"; requestId: string }
  | {
      type: "source_create"
      requestId: string
      slug: string
      verifierType?: string
      secret?: string
      skill?: string
    }
  | { type: "source_list"; requestId: string }
  | { type: "source_delete"; requestId: string; sourceId: string }
  | { type: "activity_list"; requestId: string; limit?: number }
  | { type: "account_info"; requestId: string }

export function parseServerMessage(data: string): ServerMessage | null {
  try {
    const msg = JSON.parse(data)
    if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
      return null
    }
    return msg as ServerMessage
  } catch {
    return null
  }
}

export function encodeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg)
}
