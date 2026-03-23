import { z } from "zod"

// ─── Server → Plugin schemas ───

const ServerEventSchema = z.object({
  type: z.literal("event"),
  id: z.string(),
  content: z.string(),
  meta: z.record(z.string(), z.string()),
})

const ServerPingSchema = z.object({
  type: z.literal("ping"),
})

const ServerResponseSchema = z.object({
  type: z.literal("response"),
  requestId: z.string(),
  data: z.unknown(),
  error: z.string().optional(),
})

const ServerAuthOkSchema = z.object({
  type: z.literal("auth_ok"),
})

const ServerMessageSchema = z.discriminatedUnion("type", [
  ServerEventSchema,
  ServerPingSchema,
  ServerResponseSchema,
  ServerAuthOkSchema,
])

/** Messages sent from the remote server to the local plugin */
export type ServerMessage = z.infer<typeof ServerMessageSchema>

// ─── Plugin → Server schemas ───

const ClientAuthSchema = z.object({
  type: z.literal("auth"),
  token: z.string(),
  sessionTag: z.string().optional(),
})

const ClientAckSchema = z.object({
  type: z.literal("ack"),
  eventId: z.string(),
  summary: z.string(),
})

const ClientPongSchema = z.object({
  type: z.literal("pong"),
})

const ClientCronCreateSchema = z.object({
  type: z.literal("cron_create"),
  requestId: z.string(),
  schedule: z.string(),
  prompt: z.string(),
  label: z.string().optional(),
  sessionTag: z.string().optional(),
})

const ClientCronDeleteSchema = z.object({
  type: z.literal("cron_delete"),
  requestId: z.string(),
  cronId: z.string(),
})

const ClientCronListSchema = z.object({
  type: z.literal("cron_list"),
  requestId: z.string(),
})

const ClientSourceCreateSchema = z.object({
  type: z.literal("source_create"),
  requestId: z.string(),
  slug: z.string(),
  verifierType: z.string().optional(),
  secret: z.string().optional(),
  skill: z.string().optional(),
  routes: z.record(z.string(), z.string()).optional(),
  eventType: z
    .object({
      header: z.string().optional(),
      body: z.string().optional(),
      action: z.string().optional(),
    })
    .optional(),
  sessionTag: z.string().optional(),
})

const ClientSourceListSchema = z.object({
  type: z.literal("source_list"),
  requestId: z.string(),
})

const ClientSourceDeleteSchema = z.object({
  type: z.literal("source_delete"),
  requestId: z.string(),
  sourceId: z.string(),
})

const ClientActivityListSchema = z.object({
  type: z.literal("activity_list"),
  requestId: z.string(),
  limit: z.number().optional(),
})

const ClientAccountInfoSchema = z.object({
  type: z.literal("account_info"),
  requestId: z.string(),
})

const ClientMessageSchema = z.discriminatedUnion("type", [
  ClientAuthSchema,
  ClientAckSchema,
  ClientPongSchema,
  ClientCronCreateSchema,
  ClientCronDeleteSchema,
  ClientCronListSchema,
  ClientSourceCreateSchema,
  ClientSourceListSchema,
  ClientSourceDeleteSchema,
  ClientActivityListSchema,
  ClientAccountInfoSchema,
])

/** Messages sent from the local plugin to the remote server */
export type ClientMessage = z.infer<typeof ClientMessageSchema>

export function parseServerMessage(data: string): ServerMessage | null {
  try {
    const result = ServerMessageSchema.safeParse(JSON.parse(data))
    if (!result.success) return null
    return result.data
  } catch {
    return null
  }
}

export function encodeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg)
}
