# Clawback

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) channel plugin that connects to the hosted [Clawback server](https://getclawback.io) for persistent cron scheduling and webhook delivery.

## How it works

Clawback has two parts:

1. **This plugin** — a thin WebSocket client that runs as a Claude Code MCP server. It receives events from the remote server and dispatches them as channel notifications to Claude.
2. **The server** ([getclawback.io](https://getclawback.io)) — a hosted service that receives webhooks, runs crons, manages accounts, and pushes events to connected plugins via WebSocket.

```
External Services ──POST──▶ Clawback Server ◀──WebSocket──▶ This Plugin ──▶ Claude Code
                            (Fly.io / local)                (MCP over stdio)
```

Events are dispatched one at a time. Claude processes each event and calls `event_ack` to release the next. A reminder fires after 2 minutes, and a timeout auto-advances after 5 minutes.

## Quick Start

### 1. Authenticate

Visit [getclawback.io/auth/cli](https://getclawback.io/auth/cli) to sign in with GitHub. You'll get a shell command to save your connection config — paste it in your terminal.

### 2. Install the plugin

```bash
cd clawback
bun install

# Register the MCP server
claude mcp add -s user clawback -- bun run $(pwd)/src/index.ts
```

### 3. Launch

Restart Claude Code. The plugin connects automatically on startup.

Once connected, tell Claude what you want — it has access to all the Clawback tools and will configure sources, crons, and routing for you.

## Configuration

`~/.claude/channels/clawback/config.json`:

```json
{
  "remote": "wss://getclawback.io/ws",
  "connectionToken": "cbt_your_token_here"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `remote` | Yes | WebSocket URL of the Clawback server (`ws://` for local, `wss://` for production) |
| `connectionToken` | Yes | Connection token from the server (starts with `cbt_`) |
| `dataDir` | No | Local data directory (default: `~/.claude/channels/clawback`) |

## Features

- **Webhooks** — External services POST to the server, events are pushed to Claude in real-time via WebSocket
- **Crons** — Create persistent cron jobs through Claude ("create a cron that runs /catchup every morning at 9am"). Crons are stored on the server and survive across sessions.
- **Webhook Verification** — The server supports GitHub HMAC-SHA256, Stripe signatures, and generic HMAC verification
- **Multi-account** — The server supports multiple users with isolated event queues, webhook sources, and cron jobs
- **Auto-reconnect** — If the WebSocket connection drops, the plugin reconnects automatically with exponential backoff. Events queue up on the server and drain when you reconnect.
- **Sequential Dispatch** — Events are delivered one at a time. Claude calls `event_ack` when done, releasing the next event. Includes a reminder nudge (2 min) and timeout (5 min) as safety nets.
- **Inter-agent messaging** — Sessions can send messages directly to each other via `session_send` and discover peers with `session_list`. Messages to offline sessions are durably queued. Enables multi-agent coordination without any webhook setup. Opt-in: set `"sessionMessaging": true` in config.
- **Priority and interrupt** — Events can be marked as `priority` (jumps to front of queue) or `interrupt` (stops the current event, re-queues it, and dispatches immediately). Set on sources, crons, or session messages.

## Project Structure

```
src/
  index.ts              Entry point — config, WS client, MCP server, shutdown
  mcp.ts                MCP server with channel capability + cron/ack tools
  queue.ts              EventQueue — one-at-a-time dispatch with reminder + timeout
  config.ts             Loads ~/.claude/channels/clawback/config.json
  ws/
    client.ts           WebSocket client with auto-reconnect + heartbeat
    protocol.ts         Shared message types (ServerMessage, ClientMessage)
```

## Dependencies

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) — MCP server + stdio transport
- [`croner`](https://github.com/Hexagon/croner) — Cron expression validation

## License

MIT
