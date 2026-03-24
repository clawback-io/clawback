# Clawback

Claude Code channel plugin that connects to a hosted Clawback server for webhook delivery and cron scheduling.

## What it does

This plugin is a thin WebSocket client that bridges a remote Clawback server to your local Claude Code session:

- **Receives events** (webhooks + crons) from the server via WebSocket
- **Dispatches one at a time** through a local EventQueue — Claude must call `event_ack` after each
- **Manages crons** by forwarding `cron_create`/`cron_delete`/`cron_list` over WebSocket to the server
- **Auto-reconnects** with exponential backoff if the connection drops
- **Queues acks offline** and flushes them when reconnected

The server (separate repo: [`clawback-server`](https://github.com/clawback-io/clawback-server)) handles webhook ingestion, HMAC verification, cron scheduling, multi-account isolation, and activity logging.

## Setup

### 1. Clone and install

```bash
git clone https://github.com/clawback-io/clawback.git ~/.config/claude/channels/clawback-plugin
cd ~/.config/claude/channels/clawback-plugin
bun install
```

### 2. Add the MCP server to your project

From whichever project directory you want to use Clawback in:

```bash
claude mcp add -s project clawback -- bun run --cwd ~/.config/claude/channels/clawback-plugin --shell=bun --silent start
```

Or add it globally (all projects):

```bash
claude mcp add clawback -- bun run --cwd ~/.config/claude/channels/clawback-plugin --shell=bun --silent start
```

### 3. Authenticate

Visit [getclawback.io/auth/cli](https://getclawback.io/auth/cli) to log in with GitHub. You'll get a shell command to save your connection config. Paste it in your terminal.

### 4. Restart Claude Code

The plugin will connect automatically on startup.

## Config

`$CLAUDE_CONFIG_DIR/channels/clawback/config.json` (required):

```json
{
  "remote": "wss://getclawback.io/ws",
  "connectionToken": "cbt_your_token_here",
  "notifications": true
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `remote` | Yes | WebSocket URL of the Clawback server |
| `connectionToken` | Yes | Connection token from the server (starts with `cbt_`) |
| `notifications` | No | Enable desktop notifications on event completion (default: `false`) |
| `dataDir` | No | Local data directory (default: `~/.claude/channels/clawback`) |

### Environment variables

| Variable | Description |
|----------|-------------|
| `CLAWBACK_CONFIG` | Override config file path (default: `$CLAUDE_CONFIG_DIR/channels/clawback/config.json`) |
| `CLAWBACK_SESSION` | Set session tag for multi-instance routing (see [Session routing](#session-routing)) |

### Multiple configs

Keep separate config files for production and local development:

```
~/.config/claude/channels/clawback/config.json        # production (default)
~/.config/claude/channels/clawback/config.local.json   # local dev
```

Switch with the `CLAWBACK_CONFIG` env var:

```bash
CLAWBACK_CONFIG=~/.config/claude/channels/clawback/config.local.json claude --dangerously-load-development-channels server:clawback
```

## Architecture

```
Clawback Server ←──WebSocket──→ Local Plugin ←──stdio──→ Claude Code
(webhooks, crons,                (EventQueue,             (processes events,
 activity, accounts)              dispatch, ack)            calls tools)
```

### Plugin structure

- `.claude-plugin/plugin.json` — Plugin manifest (name, version, keywords)
- `.mcp.json` — MCP server spawn config (used when installed as a plugin)
- `skills/configure/SKILL.md` — `/clawback:configure` skill for token setup

### Source

- `src/index.ts` — Entry point: loads config, creates WS client + MCP server, wires shutdown
- `src/mcp.ts` — MCP server with channel capability, forwards cron tools over WS, sends acks
- `src/queue.ts` — EventQueue: one-at-a-time dispatch with ack, reminder (2min), timeout (5min)
- `src/config.ts` — Loads config from `~/.claude/channels/clawback/config.json`
- `src/ws/client.ts` — WebSocket client with auto-reconnect, heartbeat, offline ack queue
- `src/ws/protocol.ts` — Shared message types (ServerMessage, ClientMessage)

## MCP Tools

| Tool | Description |
|------|-------------|
| `cron_create` | Create a persistent cron job (schedule + prompt/skill) |
| `cron_delete` | Delete a cron by ID |
| `cron_list` | List all crons |
| `event_ack` | Acknowledge current event (required after each event) |
| `source_create` | Create a webhook source with optional HMAC verification and skill mapping |
| `source_list` | List webhook sources |
| `source_delete` | Delete a webhook source |
| `event_history` | View recent event processing history |
| `account_info` | Show webhook base URL and connection status |
| `token_create` | Create an additional connection token for another machine |
| `token_list` | List all tokens (ID, label, last seen) without revealing values |
| `token_rotate` | Rotate current token — creates new, revokes old, updates config |
| `session_send` | Send a message to another session (or broadcast with `*`) |
| `session_list` | List all currently connected sessions |

### Skill mapping

When creating a webhook source with `source_create`, the `skill` parameter maps that source to a skill/prompt. When a webhook arrives, the skill is prepended to the payload:

```
source_create slug="github" type="github" secret="whsec_..." skill="/review"
```

This means any POST to `/webhooks/<id>/github` will be delivered to Claude as `/review` with the webhook payload as context.

## Session routing

When running multiple Claude Code instances, you can route events to specific sessions using session tags.

### Setup

Set the `CLAWBACK_SESSION` env var when starting Claude Code:

```bash
CLAWBACK_SESSION=deploys claude --dangerously-load-development-channels server:clawback
CLAWBACK_SESSION=oncall claude --dangerously-load-development-channels server:clawback
```

### Routing rules

- **Tagged source/cron** → events deliver only to the session matching that tag. If the session isn't connected, events queue until it reconnects.
- **Untagged source/cron** → events deliver only to untagged sessions (broadcast among them).
- **Tagged session** → only receives events targeted to its tag.
- **Untagged session** → only receives untagged events.

### Creating targeted sources and crons

When `CLAWBACK_SESSION` is set, `source_create` and `cron_create` default to targeting the current session. Override with `session` param or omit for broadcast:

```
source_create slug="github" type="github" secret="..." session="deploys"
cron_create schedule="0 9 * * *" prompt="/catchup" session="oncall"
```

## Key constraints

- All `meta` values in channel notifications must be `Record<string, string>` — no booleans, numbers, or null
- All logging must go to stderr (stdout is reserved for MCP JSON-RPC protocol)
- Events are dispatched one at a time — Claude must call `event_ack` after each; reminder at 2min, timeout at 5min
- Dependencies: `@modelcontextprotocol/sdk`, `croner` (for cron expression validation)
