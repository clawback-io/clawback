---
name: configure
description: Set up the Clawback channel — save the connection token and check status. Use when the user pastes a connection token, asks to configure Clawback, or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
  - mcp__clawback__account_info
---

# /clawback:configure — Clawback Channel Setup

Writes the connection config to `~/.claude/channels/clawback/config.json` and
shows the user their connection status. The server reads this file at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read the config file and call `account_info` to give the user a complete picture:

1. **Config** — check `~/.claude/channels/clawback/config.json`.
   - If missing: *"Not configured yet."*
   - If present: show remote URL and token masked (`cbt_abc...`).

2. **Connection** — call the `account_info` MCP tool to show:
   - Connection status (connected/disconnected)
   - Webhook base URL
   - Account info

3. **What next** — end with a concrete next step based on state:
   - No config → *"Run `/clawback:configure <token>` with your connection token."*
   - Config set but can't connect → *"Check your token and server URL. Get a token from the Clawback dashboard."*
   - Connected → *"Ready. Webhooks and crons are active."*

### `<token>` — save it

1. Treat `$ARGUMENTS` as the connection token (trim whitespace). Tokens start
   with `cbt_`.
2. If the argument doesn't start with `cbt_`, tell the user it doesn't look
   like a valid connection token and ask them to check.
3. `mkdir -p ~/.claude/channels/clawback`
4. Read existing `config.json` if present; update/add the `connectionToken`
   field. If no `remote` field exists, set it to `ws://localhost:3000/ws`.
5. Write back as formatted JSON (2-space indent).
6. `chmod 600 ~/.claude/channels/clawback/config.json` — the token is a credential.
7. Confirm saved, then show the no-args status so the user sees where they stand.
8. Remind the user: *"Token changes need a session restart or `/reload-plugins` to take effect."*

### `clear` — remove the config

Delete `~/.claude/channels/clawback/config.json`. Confirm removal.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `config.json` once at boot. Token changes need a session
  restart or `/reload-plugins`. Say so after saving.
- Do NOT log or display the full token — always mask it.
