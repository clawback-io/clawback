# Clawback

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) channel plugin that gives your session **persistent cron scheduling** and a **general-purpose webhook receiver**.

Claude Code's built-in crons are session-scoped and expire after 7 days. Clawback stores them on disk so they survive restarts — forever. It also runs a local HTTP server that forwards any incoming webhook straight into your Claude Code session, where Claude decides what to do with it (or invokes a skill you've mapped).

## Features

- **Persistent Crons** — Stored in `~/.clawback/crons.json`, managed via MCP tools. No expiry, loads automatically on startup.
- **Webhook Receiver** — Any POST to `localhost:18788` gets forwarded as a channel notification. Expose publicly via ngrok/Cloudflare Tunnel for external sources (GitHub, Sentry, etc).
- **Skill Mapping** — Optionally map webhook paths to skills (e.g., `/github` → `/review`). Unmapped paths let Claude decide what to do.
- **Batching** — Multiple webhooks arriving within 5 seconds are batched into a single notification, preventing Claude from being interrupted mid-task.

## Quick Start

```bash
# Clone and install
git clone https://github.com/clawback-io/clawback.git
cd clawback
bun install

# Register as an MCP server
claude mcp add -s user clawback -- bun run $(pwd)/src/index.ts

# Launch Claude Code with the channel
claude --dangerously-load-development-channels server:clawback
```

> **Note**: Do not use `--channels server:clawback` alongside the dev flag — it causes an allowlist conflict. Use only `--dangerously-load-development-channels`.

## Usage

### Webhooks

Send any POST request to the webhook server:

```bash
curl -X POST http://127.0.0.1:18788/github \
  -H 'Content-Type: application/json' \
  -d '{"action":"opened","number":42,"pull_request":{"html_url":"https://github.com/org/repo/pull/42"}}'
```

Claude receives the payload and takes action based on the content. With a skill mapping configured (see [Configuration](#configuration)), it will invoke the mapped skill automatically.

To receive webhooks from external services, expose the port with a tunnel:

```bash
ngrok http 18788
```

Then use the ngrok URL as your webhook endpoint in GitHub, Sentry, Linear, etc.

### Crons

Crons are managed through Claude Code — just ask:

> "Create a cron that runs /catchup every morning at 9am"

Claude will use the `cron_create` tool to persist it. The cron survives across sessions and fires the specified prompt/skill each time.

You can also manage them directly:

- **Create**: Claude calls `cron_create` with a schedule and prompt
- **List**: Claude calls `cron_list` to show all active crons
- **Delete**: Claude calls `cron_delete` with the cron ID

Cron definitions are stored in `~/.clawback/crons.json`:

```json
[
  {
    "id": "a1b2c3d4e5f6",
    "schedule": "0 9 * * *",
    "prompt": "/catchup",
    "label": "morning-catchup",
    "createdAt": "2026-03-22T10:00:00Z"
  }
]
```

## Configuration

Create `~/.clawback/config.json` (optional — all fields have defaults):

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

| Field | Default | Description |
|-------|---------|-------------|
| `webhookPort` | `18788` | Port for the webhook HTTP server |
| `webhookHost` | `127.0.0.1` | Host to bind the webhook server to |
| `dataDir` | `~/.clawback` | Directory for persistent data (crons.json) |
| `skills` | `{}` | Map of webhook path → skill/prompt to invoke |

### Skill Mapping

When a webhook arrives at a path that matches a key in `skills`, the skill is prepended to the notification:

```
/review

Context:
{"action":"opened","number":42,"pull_request":{"html_url":"..."}}
```

Claude then invokes the skill with the webhook payload as context. Paths without a mapping forward the raw payload and let Claude decide what to do.

## How It Works

Clawback is an MCP server that declares the `claude/channel` capability. It connects to Claude Code over stdio as a subprocess.

```
External Service ──POST──▶ Bun.serve(:18788) ──▶ channel notification ──▶ Claude Code
                                                                          Claude reads event,
                                                                          invokes skill or decides

croner tick ────────────────────────────────────▶ channel notification ──▶ Claude Code
                                                                          Claude executes the
                                                                          cron's prompt/skill

Claude Code ──tool call──▶ cron_create / cron_delete / cron_list ──▶ disk + scheduler
```

## Project Structure

```
src/
  index.ts              Entry point — wires MCP, cron, webhook; startup/shutdown
  mcp.ts                MCP server, channel capability, cron CRUD tools
  config.ts             Loads ~/.clawback/config.json
  cron/
    store.ts            Persistent JSON storage with atomic writes
    scheduler.ts        Wraps croner, fires prompt notifications
    types.ts            CronDefinition interface
  webhook/
    server.ts           Bun.serve with batching and skill mapping
    types.ts            WebhookMeta interface
```

## Dependencies

Just two runtime dependencies:

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) — MCP server + stdio transport
- [`croner`](https://github.com/Hexagon/croner) — Cron scheduling (pure JS, zero deps)

## License

MIT
