# Design Document

## Introduction

claude-nonstop is a Node.js CLI tool providing two capabilities:

1. **Multi-account switching** — Automatic rate limit detection and account switching for Claude Code, with session migration so conversations continue seamlessly.
2. **Slack remote access** — Per-session Slack channels that relay messages between Slack and Claude Code tmux sessions.

This document explains the architecture, data flow, security model, and key design decisions.

**TL;DR:** Three independent processes (CLI, webhook daemon, hook scripts) communicate via a shared JSON file and tmux. The CLI spawns Claude Code in a PTY and scrapes output for rate limits. Hooks create Slack channels on session events. The webhook relays Slack messages to tmux as keystrokes.

## Process Model

Three distinct execution contexts operate independently:

### CLI Process (`bin/claude-nonstop.js`)

The main process. Runs commands like `add`, `status`, and the default run mode. When invoked with no subcommand (or with args to pass to Claude), it spawns Claude Code as a child via `node-pty`, attaches to its stdin/stdout, and monitors output in real-time for rate limit patterns. This process is long-lived during a session.

### Webhook Process (`remote/start-webhook.cjs`)

A separate long-running daemon. Connects to Slack via Socket Mode (WebSocket). Listens for messages in session channels and relays them to tmux sessions via `tmux send-keys`. Completely independent of the CLI process — communicates via the shared `channel-map.json` file and tmux.

### Hook Processes (`remote/hook-notify.cjs`)

Short-lived processes spawned by Claude Code itself on lifecycle events (SessionStart, Stop). Each invocation reads stdin for hook context JSON and performs Slack API calls, then exits. These run in Claude Code's process environment, not in claude-nonstop's.

```
┌─────────────────┐     node-pty      ┌──────────────┐
│  CLI Process     │◄────────────────►│  Claude Code  │
│  (claude-nonstop │                   │  (child proc) │
│   )              │                   └──────┬───────┘
└─────────────────┘                          │ spawns hooks
                                              ▼
┌─────────────────┐   channel-map.json  ┌──────────────┐
│  Webhook Process │◄──────────────────►│  Hook Process │
│  (Socket Mode)   │                    │  (hook-notify)│
└────────┬────────┘                    └──────┬───────┘
         │                                     │
         │ tmux send-keys                      │ Slack API
         ▼                                     ▼
    ┌─────────┐                          ┌──────────┐
    │  tmux   │                          │  Slack   │
    └─────────┘                          └──────────┘
```

## Data Flow: Account Switching

1. CLI invoked — reads `~/.claude-nonstop/config.json` for account list
2. Reads OAuth tokens from OS keychain for each account (`lib/keychain.js`)
3. Parallel HTTP requests to `https://api.anthropic.com/api/oauth/usage` for each account
4. Scorer (`lib/scorer.js`) picks the account with lowest `max(sessionPercent, weeklyPercent)`
5. Spawns `claude` via `node-pty` with `CLAUDE_CONFIG_DIR` pointing to selected account's profile directory
6. Real-time output scanning: rolling 4KB buffer matched against the rate limit regex (see [Rolling Buffer](#2-rolling-buffer-for-rate-limit-detection))
7. On rate limit detection: SIGTERM -> 3s -> SIGKILL to Claude process
8. Find latest `.jsonl` session file in `<configDir>/projects/<cwdHash>/`
9. Copy session `.jsonl` + `tool-results/` directory to next account's config dir
10. Resume with `claude --resume <sessionId>` using the new account
11. Loop up to 5 times (`MAX_SWAPS_DEFAULT`)

## Data Flow: Cross-Profile Resume

1. `claude-nonstop resume [id]` — reads account list from `config.json`
2. Searches all `<configDir>/projects/*/` directories for the session `.jsonl` file
3. If no ID given, finds the most recently modified session across all accounts
4. Picks the best account via scorer (same as default run)
5. If session lives in a different profile, copies `.jsonl` + `tool-results/` to best account
6. Falls back to the source account if migration fails
7. Runs `claude --resume <sessionId>` with auto-switching (same as default run)

## Data Flow: Remote Access (Slack)

1. `run --remote-access` detects no tmux -> creates tmux session (named after cwd basename)
2. Re-execs itself inside tmux with `CLAUDE_REMOTE_ACCESS=true`
3. Claude Code starts, fires `SessionStart` hook -> `hook-notify.cjs session-start`
4. Hook reads stdin for `session_id`, creates Slack channel via `conversations.create`
5. Hook writes `{sessionId -> {channelId, tmuxSession, ...}}` to `channel-map.json`
6. Claude completes work -> `Stop` hook fires -> `hook-notify.cjs completed`
7. Hook reads last assistant message from transcript `.jsonl`, posts to session's Slack channel
8. User replies in Slack channel -> webhook receives message via Socket Mode
9. Webhook looks up `channel-map.json` by `channelId` to find `tmuxSession`
10. Webhook sends text to tmux via `tmux send-keys -l` (literal) + `tmux send-keys Enter`
11. Claude receives input, processes, fires Stop hook again -> cycle continues

## Security Model

### Credential Handling

- OAuth tokens are read-only from OS credential stores (macOS Keychain via `security find-generic-password`, Linux Secret Service via `secret-tool`, or fallback `.credentials.json`)
- claude-nonstop never writes, modifies, or caches tokens — it reads them on demand
- Token format: `sk-ant-oat01-...` (access tokens), `sk-ant-ort01-...` (refresh tokens)
- Tokens are passed to the Anthropic API via `Authorization: Bearer` header over HTTPS
- Tokens are passed to child processes via the `CLAUDE_CONFIG_DIR` env var (Claude Code reads its own credentials)

### Slack Tokens

- Stored in `~/.claude-nonstop/.env`
- Loaded by `remote/load-env.cjs` into `process.env` at runtime
- Bot token (`xoxb-`) and App token (`xapp-`) — both sensitive
- `.env` is in `.gitignore` to prevent accidental commits

### Trust Boundaries

- The CLI process trusts the OS keychain (reads credentials via subprocess)
- Hook processes trust Claude Code (they run as hook commands spawned by Claude Code)
- The webhook trusts Slack (messages arrive via authenticated Socket Mode connection)
- The webhook trusts `channel-map.json` for session-to-channel mapping (local file)
- `tmux send-keys` is the trust boundary for remote input — anything in a session channel gets relayed verbatim to the tmux session
- `SLACK_ALLOWED_USERS` provides an optional allowlist for Slack user IDs

### Injection Mitigations

- `tmux send-keys` uses `-l` flag for literal text relay (no tmux key interpretation)
- Account names are validated to `[a-zA-Z0-9_-]` only, with explicit path traversal checks
- Tmux message relay is truncated to 4096 chars to prevent terminal flooding

## File Layout and Data Storage

### Config Directory (`~/.claude-nonstop/`)

| File | Purpose |
|------|---------|
| `config.json` | Account registry: `{accounts: [{name, configDir}]}` |
| `.env` | Slack tokens (created by `claude-nonstop setup`) |
| `data/channel-map.json` | Session-to-Slack-channel mapping |
| `logs/webhook.log` | Webhook service stdout/stderr (macOS launchd) |
| `profiles/<name>/` | Isolated Claude Code config dirs per account |
| `profiles/<name>/settings.json` | Claude Code settings with hooks installed |

### Other Paths

| Path | Purpose |
|------|---------|
| `~/.claude/` | Default account config dir (auto-detected, not managed) |
| `~/Library/LaunchAgents/claude-nonstop-slack.plist` | Webhook launchd plist (macOS) |
| `<configDir>/projects/<cwdHash>/<sessionId>.jsonl` | Claude Code session files |
| OS Keychain | OAuth credentials (read-only access) |

### CWD Path Encoding

Claude Code stores sessions at `<configDir>/projects/<encodedCwd>/<sessionId>.jsonl`. The `encodedCwd` is the absolute CWD path with `/` replaced by `-` (not a cryptographic hash — just path encoding for filesystem safety). Example: `/Users/rc/code/myproject` becomes `-Users-rc-code-myproject`.

## Key Design Decisions

### 1. node-pty over child_process.spawn

Claude Code requires a real PTY for ANSI escape sequences, color output, and interactive mode. `child_process.spawn` with `stdio: 'pipe'` strips terminal features. **Trade-off:** node-pty has a native dependency (compilation required on install).

### 2. Rolling Buffer for Rate Limit Detection

Instead of accumulating all output, a 4KB rolling buffer is scanned against the regex:

```
/Limit reached\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im
```

This matches Claude Code's specific rate limit message (e.g., `Limit reached · resets in 2h 30m`). **Trade-off:** If a rate limit message spans a buffer trim boundary it could be missed, but in practice messages are well under 2KB. Only this specific pattern is used — generic secondary indicators like "rate limit" were removed to prevent false positives on conversational output.

### 3. File-Based IPC via channel-map.json

The webhook and hook processes share state via a JSON file rather than a database or socket. This avoids additional dependencies. **Trade-off:** Concurrent writes can race (mitigated by atomic write-to-temp + rename). Stale entries are automatically pruned after 7 days.

### 4. tmux send-keys for Remote Input

Messages are sent as keystrokes to the tmux pane rather than using Claude Code's API or stdin pipe. This works because Claude Code expects terminal input. **Trade-off:** If Claude is mid-processing (not in INSERT mode), keystrokes queue in tmux and may be delivered at unexpected times.

### 5. CJS for remote/, ESM for lib/

Hook scripts (`remote/*.cjs`) use CommonJS because Claude Code spawns them as standalone Node.js processes. The main CLI (`lib/*.js`) uses ESM. **Trade-off:** Two module systems coexist, with shared constants duplicated in `remote/paths.cjs` and `lib/config.js`.

### 6. Effective Utilization = max(session%, weekly%)

The scorer picks the account with the lowest "effective utilization" — the higher of the 5-hour session percentage or the 7-day weekly percentage. **Trade-off:** A weighted average was considered but would allow an account at 98% session / 5% weekly to be selected.

### 7. Session Migration by File Copy

When switching accounts, the session `.jsonl` and `tool-results/` are copied to the new account's config directory. `claude --resume` then picks them up. **Trade-off:** This duplicates data and assumes Claude Code's session format is stable.

### 8. No Token Caching

claude-nonstop reads tokens from the OS keychain on every operation rather than caching them. This ensures freshness but adds subprocess overhead. When tokens expire, the user re-authenticates interactively via `claude-nonstop reauth`.

### 9. launchd for Webhook Service Management

On macOS, the webhook runs as a launchd service (`claude-nonstop-slack`) with `KeepAlive: true` for automatic restarts. The `setup` command auto-installs the service, and `npm install` (via postinstall script) restarts it to pick up code changes. **Trade-off:** macOS-only — Linux users must manage the webhook process manually (systemd or screen/tmux). The postinstall script is self-contained (no `lib/` imports) to avoid failures during initial install.

## Slack Communication Improvements

### Problem

When using claude-nonstop via Slack remote access, the user gets limited visibility into what Claude is doing. They send a message, see an hourglass reaction, then silence until the final response. No progress, no tool activity, no errors, no way to interrupt.

### Architecture: PostToolUse Hook for Progress

Progress updates use Claude Code's `PostToolUse` hook, which provides structured JSON (including `session_id`, `tool_name`, `tool_input`) on stdin. This replaces the previous PTY scraping approach which was fragile due to terminal output format changes.

```
Claude Code tool use
  → PostToolUse hook fires
    → hook-notify.cjs "tool-use" (async, non-blocking)
      → extractToolDetail(tool_name, tool_input) → human-readable detail
      → append event to buffer file (~/.claude-nonstop/data/progress/progress-<session_id>.json)
      → if 10s since last flush: format message, call updateProgressMessage(), clear buffer
```

**Why PostToolUse hooks over PTY scraping:** Structured JSON input is reliable regardless of terminal output format changes. The hook provides `session_id` directly, avoiding CWD-based fallback lookups. The `async: true` flag ensures hooks don't block Claude's agentic loop. Trade-off: one short-lived process per tool call, but with buffered Slack updates (every 10s) the Slack API overhead is minimal.

### Updatable Progress Message

A single Slack message is created on first tool activity and updated every 10s with accumulated events. The message is cleared when the Stop hook fires. `progressMessageTs` is stored in `channel-map.json` per session.

### Control Commands

Session channels support commands before tmux relay:
- `!stop` — sends Ctrl+C to the tmux session
- `!status` — captures tmux pane content, posts as code block
- `!help` — lists available commands
- `!archive` — archives the channel (existing)

### Structured Completion Messages

When Claude completes a turn, the Stop hook now:
1. Parses the transcript `.jsonl` for the current turn (`parseCurrentTurn`)
2. Extracts tool_use entries (grouped by tool name with file paths) and final assistant text
3. Posts a Block Kit message with header, activity summary, and truncated response
4. Posts full response as a thread reply if > 500 chars

### Account Switch Notifications

When runner.js detects a rate limit and switches accounts, it spawns `hook-notify.cjs account-switch` with session context. Slack receives a message like: `:arrows_counterclockwise: Rate limited on "default", switching to "work" (swap 1/5)`.

### Relay Failure Visibility

If `tmux send-keys` fails (non-zero exit), the webhook posts a warning to the channel instead of silently failing. Per-session messages get an `:eyes:` reaction on receipt.

### hook-notify Event Types

| Event | Spawned by | Trigger |
|-------|-----------|---------|
| `session-start` | Claude Code SessionStart hook | Session created |
| `completed` | Claude Code Stop hook | Claude completes a turn |
| `tool-use` | Claude Code PostToolUse hook | Tool use completed (buffered, flushed every 10s) |
| `account-switch` | runner.js | Rate limit detected, switching to next account |

### New channel-map.json Fields

| Field | Purpose |
|-------|---------|
| `progressMessageTs` | Timestamp of the updatable progress message (for `chat.update`) |

## Module Dependency Graph

```
bin/claude-nonstop.js
  ├── lib/config.js
  ├── lib/keychain.js ─── lib/config.js (DEFAULT_CLAUDE_DIR)
  ├── lib/usage.js
  ├── lib/scorer.js
  ├── lib/platform.js
  ├── lib/service.js ─── lib/platform.js
  ├── lib/session.js (dynamic import, resume command only)
  ├── lib/runner.js
  │     ├── lib/keychain.js
  │     ├── lib/usage.js
  │     ├── lib/scorer.js
  │     ├── lib/session.js
  │     ├── lib/reauth.js ─── lib/keychain.js
  │     └── (spawns) remote/hook-notify.cjs (account-switch)
  ├── lib/reauth.js
  └── lib/tmux.js

scripts/postinstall.js              (self-contained, no lib/ imports)

remote/hook-notify.cjs
  ├── remote/load-env.cjs ─── remote/paths.cjs
  ├── remote/paths.cjs (PROGRESS_DIR)
  └── remote/channel-manager.cjs ─── remote/paths.cjs

remote/start-webhook.cjs
  ├── remote/load-env.cjs
  └── remote/webhook.cjs
        └── remote/channel-manager.cjs
```
