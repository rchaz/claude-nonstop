# claude-nonstop

Multi-account switching + Slack remote access for Claude Code.

**Multi-account switching:** When you hit a rate limit mid-session, claude-nonstop kills the idle process, migrates your session to a different account, and resumes — fully automated, zero downtime.

**Slack remote access:** Each Claude Code session gets a dedicated Slack channel. Send messages in the channel to control Claude remotely. Claude's responses are posted back to the channel.

> **Platform:** Tested on macOS only. Linux may work but is untested.

## Install

The easiest way to install is to ask Claude Code:

```
You: set up claude-nonstop for me
```

Claude Code will follow the [setup instructions in CLAUDE.md](CLAUDE.md#setting-up-claude-nonstop-for-a-user) to install, configure accounts, and set up Slack remote access interactively.

### Manual install

**Prerequisites:**

- **Node.js 18+** — [Download](https://nodejs.org/)
- **C/C++ build tools** — macOS: `xcode-select --install`
- **Claude Code CLI** — [Install guide](https://docs.anthropic.com/en/docs/claude-code/overview). Verify with: `claude --version`
- **2+ Claude accounts** for multi-account switching (each needs its own subscription)
- **tmux** for Slack remote access: `brew install tmux`

```bash
git clone https://github.com/rchaz/claude-nonstop.git
cd claude-nonstop
npm install -g "$(npm pack)"
```

If `npm install -g` fails with compilation errors, you're missing C/C++ build tools.

Verify:

```bash
claude-nonstop help
```

## Quick Start: Multi-Account Switching

### 1. Confirm your default account

Your existing `~/.claude` account is auto-detected:

```bash
claude-nonstop list
```

Expected output:

```
Accounts:

  default
    Config: /Users/you/.claude
    Status: authenticated
```

If status shows `not authenticated`, open a Claude Code session (`claude`) and type `/login` inside the session to authenticate.

### 2. Add additional accounts

```bash
claude-nonstop add work
```

Account names must contain only letters, numbers, hyphens, and underscores, up to 64 characters (e.g., `work`, `team-2`, `personal_backup`). The name `default` is reserved for the auto-detected `~/.claude` account.

This creates an isolated config directory and runs `claude auth login`, which opens your browser for OAuth. Complete the login in the browser and the CLI picks up the credentials automatically — no interactive Claude session needed.

After login, claude-nonstop checks for duplicate accounts (same email as an existing account). If detected, the new account is automatically removed with an error.

Repeat for more accounts (each must be a different Claude subscription):

```bash
claude-nonstop add personal
claude-nonstop add team
```

### 3. Verify all accounts

```bash
claude-nonstop status
```

Expected output:

```
  default (alice@gmail.com) <-- best
    5-hour:  ███░░░░░░░░░░░░░░░░░ 14%
    7-day:   ██████░░░░░░░░░░░░░░ 29%

  work (alice@company.com)
    5-hour:  █░░░░░░░░░░░░░░░░░░░ 3%
    7-day:   ██░░░░░░░░░░░░░░░░░░ 8%
```

### 4. Use it

```bash
claude-nonstop
claude-nonstop -p "fix the auth bug in login.ts"
```

Rate limit switching happens automatically. Your conversation continues on a different account with no intervention.

**If something goes wrong:**
- OAuth login doesn't complete? Re-run: `claude-nonstop reauth`
- Status shows `error (HTTP 401)`? Token expired — run `claude-nonstop reauth`
- "No credentials found"? Re-authenticate: `CLAUDE_CONFIG_DIR="$HOME/.claude-nonstop/profiles/<name>" claude auth login`

### 5. Set up aliases (optional)

Add to `~/.zshrc` or `~/.bashrc`:

```bash
alias claude='claude-nonstop'
alias cn='claude-nonstop --dangerously-skip-permissions'
```

## Quick Start: Slack Remote Access

**Important:** Slack message relay sends keystrokes to the tmux session. Claude Code must be in INSERT mode (waiting for input) for messages to be received. If Claude is mid-processing, keystrokes queue in tmux and are delivered when Claude next waits for input.

### 1. Create a Slack App

**Option A: One-click with manifest (recommended)**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) > **Create New App** > **From a manifest**
2. Select your workspace
3. Paste the contents of [`slack-manifest.yaml`](slack-manifest.yaml) from this repo
4. Click **Create**
5. Go to **Install App** > **Install to Workspace** and authorize

**Option B: Manual setup**

<details>
<summary>Click to expand manual steps</summary>

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app.

**Enable Socket Mode:**
- Settings > Socket Mode > Enable
- Create an App-Level Token with `connections:write` scope
- Save the token (starts with `xapp-`)

**Add Bot Token Scopes** (OAuth & Permissions > Scopes > Bot Token Scopes):

| Scope | Purpose |
|-------|---------|
| `chat:write` | Send messages to channels |
| `channels:manage` | Create, archive, set topic on channels |
| `channels:history` | Receive messages in channels |
| `channels:read` | Look up channel info |
| `reactions:read` | Read reactions (typing indicator) |
| `reactions:write` | Add/remove reactions (typing indicator) |
| `app_mentions:read` | Respond to @mentions |
| `im:history` | Read DM history |
| `im:read` | Read DM info |
| `im:write` | Send DMs |

**Subscribe to Bot Events** (Event Subscriptions > Subscribe to bot events):
- `message.channels`
- `message.im`
- `app_mention`

**Install the app** to your workspace (OAuth & Permissions > Install to Workspace).

</details>

**After creating the app, collect two tokens:**

1. **Bot Token** (starts with `xoxb-`) — from **OAuth & Permissions** page. This is created automatically when you install the app.

2. **App Token** (starts with `xapp-`) — from **Basic Information > App-Level Tokens**. This must be generated manually (the manifest enables Socket Mode but cannot create the token). Click **Generate Token and Scopes**, name it anything (e.g., `socket`), add the **`connections:write`** scope (the only scope needed — all read/write permissions are on the bot token), and click **Generate**.

### 2. Run setup

**Interactive:**

```bash
claude-nonstop setup
```

This prompts for your Slack tokens, writes `~/.claude-nonstop/.env`, and installs Claude Code hooks into all profile settings.

**Non-interactive** (for scripts/agents — skip all prompts):

```bash
# Pass tokens directly
claude-nonstop setup --bot-token xoxb-your-token --app-token xapp-your-token

# Or read from environment (tokens stay out of shell history)
export SLACK_BOT_TOKEN=xoxb-your-token
export SLACK_APP_TOKEN=xapp-your-token
claude-nonstop setup --from-env
```

Optional fields use sensible defaults when omitted. Override with additional flags:

```bash
claude-nonstop setup --from-env --channel-prefix myprefix --allowed-users U12345,U67890
```

You should see `Installed hooks: <name>` for each account and a "Setup complete!" message.

Verify hooks were installed:

```bash
claude-nonstop hooks status
```

All profiles should show `Stop: installed` and `SessionStart: installed`.

### 3. Start the webhook

On macOS, `setup` automatically installs the webhook as a launchd service that starts on login and restarts on failure. Check it's running:

```bash
claude-nonstop webhook status
```

You should see `Status: running` with a PID. If the webhook isn't running, check the logs:

```bash
claude-nonstop webhook logs
```

If you need to manually install the service (e.g., after reinstalling):

```bash
claude-nonstop webhook install
```

For debugging, you can run the webhook in the foreground:

```bash
claude-nonstop webhook start   # Runs in foreground (Ctrl+C to stop)
```

### 4. Run with remote access

```bash
claude-nonstop --remote-access
```

This automatically:
1. Creates a tmux session named after the current directory
2. Sets `CLAUDE_REMOTE_ACCESS=true` so each session gets a dedicated Slack channel
3. Enables `--dangerously-skip-permissions` for unattended operation

**Security note:** `--dangerously-skip-permissions` allows Claude to run any tool (file edits, shell commands) without confirmation prompts. This is required for unattended operation but means Claude has full access to your system. Use `SLACK_ALLOWED_USERS` in your `.env` to restrict who can send commands via Slack.

A Slack channel like `#cn-myproject-abc12345` is created (the suffix is the Claude session ID). Reply in the channel to send messages to Claude.

**If something goes wrong:**
- Slack channel not created? Check hooks: `claude-nonstop hooks status` (all should show "installed")
- Webhook not receiving messages? Check status: `claude-nonstop webhook status`, then logs: `claude-nonstop webhook logs`
- Messages not reaching Claude? Verify the tmux session exists (`tmux ls`) and that Claude is waiting for input

### End-to-end flow

```
claude-nonstop setup   # also installs webhook as launchd service on macOS
claude-nonstop --remote-access
  → detects no tmux → creates tmux session "myproject"
  → picks best account, spawns claude with CLAUDE_REMOTE_ACCESS=true
  → Claude's SessionStart hook fires → creates Slack channel #cn-myproject-abc12345
  → Claude completes work → Stop hook posts response to the channel
  → You reply in Slack → webhook relays message to tmux → Claude receives it
```

## Commands

| Command | Description |
|---------|-------------|
| `[args...]` | Run Claude with best account + auto-switching (default) |
| `--remote-access` | Run with tmux + Slack per-session channels |
| `resume [id]` | Resume a session from any account (finds + migrates to best account) |
| `add <name>` | Register a new Claude account and launch login (detects duplicates) |
| `remove <name>` | Remove a registered account |
| `reauth` | Re-authenticate accounts with expired tokens |
| `list` | List all accounts with auth status |
| `status` | Show detailed usage for all accounts |
| `setup [flags]` | Slack remote access setup (auto-installs webhook service on macOS) |
| `webhook` | Show webhook subcommands |
| `webhook start` | Start the Slack webhook in foreground (for debugging) |
| `webhook install` | Install + start webhook as launchd service (macOS) |
| `webhook uninstall` | Stop + remove webhook launchd service |
| `webhook restart` | Restart the webhook service |
| `webhook status` | Show webhook service status (installed/running/PID) |
| `webhook logs` | Tail the webhook log file |
| `hooks install` | Install Claude Code hooks into all profile settings |
| `hooks status` | Show hook installation status for all profiles |
| `update` | Reinstall from local source (preserves all config) |
| `uninstall [--force]` | Remove claude-nonstop completely (service, hooks, config) |
| `help` | Show help |

Any unrecognized arguments are passed through to `claude` directly.

## How Multi-Account Switching Works

1. **Pre-flight check** — Queries the Anthropic usage API for all accounts (~200ms). Picks the one with the most headroom.
2. **Real-time monitoring** — Watches Claude's stdout for rate limit messages (`Limit reached · resets ...`) as they stream. No polling.
3. **Auto-switch** — On detection: kills the paused process, migrates session files to the next best account, resumes with `claude --resume`.
4. **Session migration** — Copies the `.jsonl` session file and `tool-results/` directory to the new account's config dir. The conversation continues seamlessly.

## How Slack Remote Access Works

Claude Code supports [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — shell commands triggered on events. claude-nonstop installs two hooks:

| Hook | Event | Action |
|------|-------|--------|
| `SessionStart` | Claude session begins | Creates a Slack channel for this session |
| `Stop` | Claude finishes a task | Posts structured completion message with tool activity summary |

The Slack webhook runs as a separate process. It connects via Socket Mode and listens for messages in session channels. When you type in a channel, it relays your message to the corresponding tmux session via `tmux send-keys`.

**Progress updates:** While Claude works, the runner scrapes PTY output for tool activity (file reads, edits, bash commands) and updates a single Slack message every ~10 seconds. You can see what Claude is doing in near-real-time.

**Control commands:** Type these in a session channel:

| Command | Action |
|---------|--------|
| `!stop` | Interrupt Claude (Ctrl+C) |
| `!status` | Show current terminal output |
| `!help` | List available commands |
| `!archive` | Archive the channel |

**Account switch visibility:** If Claude hits a rate limit and switches accounts, a notification is posted to the channel.

**Note:** See the INSERT mode caveat at the [top of this section](#quick-start-slack-remote-access).

## Architecture

```
claude-nonstop/
├── bin/claude-nonstop.js         CLI entry point and command routing
├── lib/
│   ├── config.js                 Account registry (~/.claude-nonstop/config.json)
│   ├── keychain.js               OS credential store reading
│   ├── usage.js                  Anthropic usage API client
│   ├── scorer.js                 Best-account selection
│   ├── session.js                Session file migration + cross-profile search
│   ├── runner.js                 Process wrapper + rate limit detection
│   ├── service.js                launchd service management (macOS)
│   ├── tmux.js                   tmux session management
│   ├── reauth.js                 Re-authentication flow
│   └── platform.js               OS detection
├── remote/                       Slack remote access subsystem
│   ├── hook-notify.cjs           Hook entry point (called by Claude Code hooks)
│   ├── channel-manager.cjs       Slack channel lifecycle (create, post, archive)
│   ├── webhook.cjs               Socket Mode handler (Slack → tmux relay)
│   ├── start-webhook.cjs         Webhook process entry point
│   ├── load-env.cjs              Environment file loader
│   └── paths.cjs                 Shared path constants for CJS modules
├── scripts/
│   └── postinstall.js            Restart webhook service on npm install
└── .env.example                  Configuration template

~/.claude-nonstop/                User data directory
├── config.json                   Account registry
├── .env                          Slack tokens (created by setup)
├── data/
│   └── channel-map.json          Session → Slack channel mapping
├── logs/
│   └── webhook.log               Webhook service log (macOS launchd)
└── profiles/                     Isolated config dirs per account
```

### Key paths

| Path | Purpose |
|------|---------|
| `~/.claude-nonstop/config.json` | Account registry (names + config dir paths) |
| `~/.claude-nonstop/.env` | Slack tokens and configuration |
| `~/.claude-nonstop/data/channel-map.json` | Session-to-Slack-channel mapping |
| `~/.claude-nonstop/logs/webhook.log` | Webhook service log (macOS launchd) |
| `~/.claude-nonstop/profiles/<name>/` | Isolated config dirs for each account |
| `~/.claude-nonstop/profiles/<name>/settings.json` | Claude Code settings + hooks per profile |
| `~/Library/LaunchAgents/claude-nonstop-slack.plist` | Webhook launchd plist (macOS) |
| `~/.claude/` | Default account config dir (auto-detected) |
| OS Keychain | OAuth tokens (read-only by claude-nonstop) |

## Troubleshooting

### `npm install` fails with compilation errors

The `node-pty` package requires a C/C++ compiler:

```bash
xcode-select --install
```

Then re-run `npm install`.

### Hooks not firing / Slack channel not created

**Most common issue:** Each Claude Code account has its own `CLAUDE_CONFIG_DIR`, and hooks are configured in `settings.json` within that directory. If you added accounts before running `setup`, the hooks may be missing.

Fix:

```bash
claude-nonstop hooks install
claude-nonstop hooks status    # Verify all show "installed"
```

### "No credentials found" after adding an account

Re-run the login for that account:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-nonstop/profiles/<name>" claude auth login
```

### Usage shows "error (HTTP 401)"

OAuth token expired. Re-authenticate all expired accounts:

```bash
claude-nonstop reauth
```

This checks all accounts and opens the browser for OAuth login for each expired one.

### Webhook not receiving messages

- Check webhook is running: `claude-nonstop webhook status`
- Check logs: `claude-nonstop webhook logs`
- Verify Socket Mode is enabled in your Slack app settings
- Verify bot events `message.channels` and `message.im` are subscribed

### Slack channel created but messages not reaching Claude

- Claude must be in INSERT mode (waiting for input)
- Check the tmux session exists: `tmux ls`
- Check `~/.claude-nonstop/data/channel-map.json` has the correct tmux session name

### Session migration failed

claude-nonstop starts a fresh session on the new account. The previous session is still intact in the original account's config dir.

## Setup via AI Agent

See [CLAUDE.md](CLAUDE.md#setting-up-claude-nonstop-for-a-user) for step-by-step instructions designed for AI agents, including prerequisites checks, what can/cannot be automated, and a non-interactive `.env` setup path.

## Platform Support

| Platform | Credential Store | Service Management | Status |
|----------|-----------------|-------------------|--------|
| macOS | Keychain (`security`) | launchd | Tested |
| Linux | Secret Service (`secret-tool`) | Manual (systemd example in docs) | Untested |
| Windows | — | — | Not supported |

## License

[MIT](LICENSE)
