# Clawback

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) channel plugin that connects to a hosted [Clawback server](https://github.com/clawback-io/clawback-server) for persistent cron scheduling and webhook delivery.

## How it works

Clawback has two parts:

1. **This plugin** — a thin WebSocket client that runs as a Claude Code MCP server. It receives events from the remote server and dispatches them as channel notifications to Claude.
2. **The server** ([`clawback-server`](https://github.com/clawback-io/clawback-server)) — a hosted service that receives webhooks, runs crons, manages accounts, and pushes events to connected plugins via WebSocket.

```
External Services ──POST──▶ Clawback Server ◀──WebSocket──▶ This Plugin ──▶ Claude Code
                            (Fly.io / local)                (MCP over stdio)
```

Events are dispatched one at a time. Claude processes each event and calls `event_ack` to release the next. A reminder fires after 2 minutes, and a timeout auto-advances after 5 minutes.

## Quick Start

### 1. Set up the server

See the [clawback-server README](https://github.com/clawback-io/clawback-server) for server setup. For local development:

```bash
cd clawback-server
docker compose up -d        # Start Postgres
bun run db:push             # Create tables
bun run db:seed             # Create dev user + connection token
bun run dev                 # Start server on port 3000
```

### 2. Configure the plugin

Create `~/.clawback/config.json` with the token from the seed output:

```json
{
  "remote": "ws://localhost:3000/ws",
  "connectionToken": "cbt_your_token_here"
}
```

### 3. Register and launch

```bash
cd clawback
bun install

# Register as an MCP server
claude mcp add -s user clawback -- bun run $(pwd)/src/index.ts

# Launch Claude Code with the channel
claude --dangerously-load-development-channels server:clawback
```

> **Note**: Do not use `--channels server:clawback` alongside the dev flag — it causes an allowlist conflict. Use only `--dangerously-load-development-channels`.

### 4. Test it

Send a webhook to the server (use the webhook ID from the seed output):

```bash
curl -X POST http://localhost:3000/webhooks/<your-webhook-id>/test \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello from the server!"}'
```

Claude will receive the event and act on it.

## Configuration

`~/.clawback/config.json`:

```json
{
  "remote": "wss://your-server.fly.dev/ws",
  "connectionToken": "cbt_your_token_here"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `remote` | Yes | WebSocket URL of the Clawback server (`ws://` for local, `wss://` for production) |
| `connectionToken` | Yes | Connection token from the server (starts with `cbt_`) |
| `dataDir` | No | Local data directory (default: `~/.clawback`) |

## Features

- **Webhooks** — External services POST to the server, events are pushed to Claude in real-time via WebSocket
- **Crons** — Create persistent cron jobs through Claude ("create a cron that runs /catchup every morning at 9am"). Crons are stored on the server and survive across sessions.
- **Webhook Verification** — The server supports GitHub HMAC-SHA256, Stripe signatures, and generic HMAC verification
- **Multi-account** — The server supports multiple users with isolated event queues, webhook sources, and cron jobs
- **Auto-reconnect** — If the WebSocket connection drops, the plugin reconnects automatically with exponential backoff. Events queue up on the server and drain when you reconnect.
- **Sequential Dispatch** — Events are delivered one at a time. Claude calls `event_ack` when done, releasing the next event. Includes a reminder nudge (2 min) and timeout (5 min) as safety nets.

## Project Structure

```
src/
  index.ts              Entry point — config, WS client, MCP server, shutdown
  mcp.ts                MCP server with channel capability + cron/ack tools
  queue.ts              EventQueue — one-at-a-time dispatch with reminder + timeout
  config.ts             Loads ~/.clawback/config.json
  ws/
    client.ts           WebSocket client with auto-reconnect + heartbeat
    protocol.ts         Shared message types (ServerMessage, ClientMessage)
```

## Dependencies

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) — MCP server + stdio transport
- [`croner`](https://github.com/Hexagon/croner) — Cron expression validation

## License

MIT
