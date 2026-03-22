export interface WebhookMeta {
  source: "webhook"
  path: string
  method: string
  contentType: string
  timestamp: string
}
