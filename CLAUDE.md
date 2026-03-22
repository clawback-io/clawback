# Clawback

Claude Code channel plugin that connects to a hosted Clawback server for webhook delivery and cron scheduling.

## What it does

This plugin is a thin WebSocket client that bridges a remote Clawback server to your local Claude Code session:

- **Receives events** (webhooks + crons) from the server via WebSocket
- **Dispatches one at a time** through a local EventQueue — Claude must call `event_ack` after each
- **Manages crons** by forwarding `cron_create`/`cron_delete`/`cron_list` over WebSocket to the server
- **Auto-reconnects** with exponential backoff if the connection drops
- **Queues acks offline** and flushes them when reconnected

The server (separate repo: `clawback-server`) handles webhook ingestion, HMAC verification, cron scheduling, multi-account isolation, and activity logging.

## Setup

### 1. Configure the connection

Create `~/.clawback/config.json`:

```json
{
  "remote": "wss://your-server.fly.dev/ws",
  "connectionToken": "cbt_your_token_here"
}
```

Get a connection token by authenticating with the hosted server (OAuth flow or dev seed).

For local development with a local server:
```json
{
  "remote": "ws://localhost:3000/ws",
  "connectionToken": "cbt_your_dev_token"
}
```

### 2. Register the MCP server

```bash
claude mcp add -s user clawback -- bun run /path/to/clawback/src/index.ts
```

### 3. Launch Claude Code

```bash
claude --dangerously-load-development-channels server:clawback
```

**Important**: Do NOT use `--channels server:clawback` alongside the dev flag — it causes an allowlist conflict. Use only `--dangerously-load-development-channels`.

## Config

`~/.clawback/config.json` (required):

```json
{
  "remote": "wss://your-server.fly.dev/ws",
  "connectionToken": "cbt_your_token_here"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `remote` | Yes | WebSocket URL of the Clawback server |
| `connectionToken` | Yes | Connection token from the server (starts with `cbt_`) |
| `dataDir` | No | Local data directory (default: `~/.clawback`) |

## Architecture

```
Clawback Server ←──WebSocket──→ Local Plugin ←──stdio──→ Claude Code
(webhooks, crons,                (EventQueue,             (processes events,
 activity, accounts)              dispatch, ack)            calls tools)
```

- `src/index.ts` — Entry point: loads config, creates WS client + MCP server, wires shutdown
- `src/mcp.ts` — MCP server with channel capability, forwards cron tools over WS, sends acks
- `src/queue.ts` — EventQueue: one-at-a-time dispatch with ack, reminder (2min), timeout (5min)
- `src/config.ts` — Loads config from `~/.clawback/config.json`
- `src/ws/client.ts` — WebSocket client with auto-reconnect, heartbeat, offline ack queue
- `src/ws/protocol.ts` — Shared message types (ServerMessage, ClientMessage)

## Key constraints

- All `meta` values in channel notifications must be `Record<string, string>` — no booleans, numbers, or null
- All logging must go to stderr (stdout is reserved for MCP JSON-RPC protocol)
- Events are dispatched one at a time — Claude must call `event_ack` after each; reminder at 2min, timeout at 5min
- Dependencies: `@modelcontextprotocol/sdk`, `croner` (for cron expression validation)
