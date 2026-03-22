# Clawback

Claude Code channel plugin providing persistent cron scheduling and a general webhook receiver.

## What it does

- **Persistent Crons**: Stored in `~/.clawback/crons.json`, managed via MCP tools (`cron_create`, `cron_delete`, `cron_list`). No expiry, survives across sessions.
- **Webhook Receiver**: HTTP server on `localhost:18788` that forwards any POST as a channel notification to Claude Code. Webhooks are batched (5s debounce) to prevent interrupting Claude mid-task.
- **Event Queue**: All events (webhooks + crons) flow through a single queue that dispatches one at a time. Claude must call `event_ack` after handling each event to release the next. A reminder nudge fires after 2 minutes, and a timeout auto-advances after 5 minutes if no ack arrives.
- **Skill Mapping**: Optional config in `~/.clawback/config.json` maps webhook paths to skills (e.g., `/github` → `/review`). Unmapped paths forward the raw payload and let Claude decide.

## Running

```bash
bun install
claude --dangerously-load-development-channels server:clawback
```

**Important**: Do NOT use `--channels server:clawback` alongside the dev flag — it causes an allowlist conflict. Use only `--dangerously-load-development-channels`.

The MCP server must be registered first:
```bash
claude mcp add -s user clawback -- bun run /Users/peter/code/CLAW/clawback/src/index.ts
```

## Testing

```bash
# Send a webhook
curl -X POST http://127.0.0.1:18788/github -H 'Content-Type: application/json' -d '{"action":"opened","number":42,"pull_request":{"html_url":"https://github.com/org/repo/pull/42"}}'

# Expose publicly for external webhooks
ngrok http 18788
```

## Config

`~/.clawback/config.json` (optional, all fields have defaults):

```json
{
  "webhookPort": 18788,
  "webhookHost": "127.0.0.1",
  "dataDir": "~/.clawback",
  "skills": {
    "/github": "/review",
    "/alert": "Investigate this error and suggest a fix"
  }
}
```

## Architecture

- `src/index.ts` — Entry point, wires MCP + cron + webhook, startup/shutdown
- `src/mcp.ts` — MCP server with channel capability, cron CRUD + event_ack tools, notification helper
- `src/queue.ts` — EventQueue: one-at-a-time dispatch with ack, reminder, and timeout
- `src/config.ts` — Loads config from `~/.clawback/config.json`
- `src/cron/store.ts` — Persistent JSON storage with atomic writes
- `src/cron/scheduler.ts` — Wraps croner library, enqueues cron events into EventQueue
- `src/cron/types.ts` — CronDefinition interface
- `src/webhook/server.ts` — Bun.serve HTTP server with debounce batching, enqueues into EventQueue
- `src/webhook/types.ts` — WebhookMeta interface

## Key constraints

- All `meta` values in channel notifications must be `Record<string, string>` — no booleans, numbers, or null
- All logging must go to stderr (stdout is reserved for MCP JSON-RPC protocol)
- MCP must connect before cron scheduler starts (prevents notification-before-connected errors)
- Events are dispatched one at a time — Claude must call `event_ack` after each; reminder at 2min, timeout at 5min
- Dependencies: `@modelcontextprotocol/sdk`, `croner` (that's it)
