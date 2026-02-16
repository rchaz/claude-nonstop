# Repository Guidelines

- Repo: https://github.com/rchaz/claude-nonstop
- Architecture: [DESIGN.md](DESIGN.md)

## Project Overview

claude-nonstop is a Node.js CLI tool that provides multi-account switching and Slack remote access for Claude Code. It handles OAuth credentials, rate limit detection, session migration, and Slack channel lifecycle.

## Project Structure & Module Organization

```
bin/claude-nonstop.js         CLI entry point, command routing (ESM)
lib/                          Core logic (ESM, .js)
  config.js                   Account registry, path constants, validation
  runner.js                   Process wrapper, rate limit detection, session migration
  usage.js                    Anthropic usage API client
  scorer.js                   Best-account selection algorithm
  keychain.js                 OS credential store reading
  session.js                  Session file migration + cross-profile search
  service.js                  launchd service management (macOS)
  tmux.js                     tmux session management
  platform.js                 OS detection
  reauth.js                   Re-authentication flow
remote/                       Slack remote access subsystem (CJS, .cjs)
  hook-notify.cjs             Hook entry point (called by Claude Code hooks and runner.js)
  webhook.cjs                 Socket Mode handler (Slack -> tmux relay)
  start-webhook.cjs           Webhook process entry point
  channel-manager.cjs         Slack channel lifecycle (create, post, archive)
  paths.cjs                   Shared path constants for CJS modules
  load-env.cjs                .env loader for CJS modules
scripts/
  postinstall.js              Restart webhook service on npm install
```

### Module System (ESM / CJS split)

- `lib/` uses **ESM** (`import`/`export`, `.js` extension)
- `remote/` uses **CJS** (`require`/`module.exports`, `.cjs` extension)
- `bin/claude-nonstop.js` is ESM

CJS is required in `remote/` because Claude Code spawns hook scripts as standalone Node.js processes — they must be self-contained.

**Do not** convert `remote/*.cjs` to ESM. **Do not** add ESM imports to `remote/` files.

### Path Constants

Two sources of truth for paths (one per module system):
- **ESM modules** import from `lib/config.js`: `CONFIG_DIR`, `DEFAULT_CLAUDE_DIR`, `PROFILES_DIR`
- **CJS modules** import from `remote/paths.cjs`: `CONFIG_DIR`, `ENV_PATH`, `DATA_DIR`, `CHANNEL_MAP_PATH`

Do not duplicate path definitions. Do not hardcode `~/.claude-nonstop/` anywhere.

## Build, Test, and Verification

### Verify syntax after changes

```bash
npm run check
```

Or individually:

```bash
node --check lib/*.js
node --check remote/*.cjs
node --check bin/claude-nonstop.js
node --check scripts/postinstall.js
```

### Run the CLI

```bash
claude-nonstop help
claude-nonstop list
claude-nonstop status
claude-nonstop resume           # resume most recent session (any account)
claude-nonstop resume <id>      # resume specific session by ID
```

### Test account name validation

```bash
# These should fail with validation errors:
claude-nonstop add '../bad'
claude-nonstop add 'has spaces'
claude-nonstop add ''
```

### Verify hooks

```bash
claude-nonstop hooks status
```

## Coding Style & Conventions

- Runtime baseline: Node **18+**
- Use `const` over `let` where possible
- Use descriptive variable names
- Keep functions focused and small
- Follow existing patterns in the codebase
- Add brief comments only for tricky or non-obvious logic
- No TypeScript — this is a plain Node.js project

## Security Rules

These are **hard rules**. Do not relax them.

- **Never** use `exec()` or `execSync()` with string interpolation for subprocess calls. Always use `execFile`/`execFileSync` with array arguments.
- **Never** construct shell commands by concatenating user input (account names, session IDs, Slack messages, file paths).
- **Always** validate account names with `validateAccountName()` from `lib/config.js` before using them in file paths.
- **Always** use `AbortController` with timeout on HTTP fetch calls.
- **Always** use atomic writes (write-to-temp + rename) for shared data files like `channel-map.json` and `config.json`.
- **Never** log or expose OAuth tokens (`sk-ant-oat01-*`, `sk-ant-ort01-*`), Slack tokens (`xoxb-*`, `xapp-*`), or other credentials in output, error messages, or stack traces.
- Truncate tmux message relay to `MAX_TMUX_MESSAGE_LENGTH` (4096 chars).
- Slack `.env` files must live in `~/.claude-nonstop/.env`, never in the project directory.

## Hook Notification Types

`hook-notify.cjs` handles these notification types (passed as first CLI argument):

| Type | Source | Purpose |
|------|--------|---------|
| `session-start` | Claude Code SessionStart hook | Create per-session Slack channel |
| `completed` | Claude Code Stop hook | Post structured completion message |
| `tool-use` | Claude Code PostToolUse hook | Buffer tool activity, flush to Slack every 10s |
| `account-switch` | runner.js (on rate limit) | Notify about account switch |

## Slack Control Commands

In per-session Slack channels, these commands are handled before tmux relay:

| Command | Action |
|---------|--------|
| `!stop` | Send Ctrl+C to tmux session |
| `!status` | Capture and post terminal pane content |
| `!help` | Show available commands |
| `!archive` | Archive the Slack channel |

## Important Patterns & Gotchas

- `loadConfig()` reads config from disk and ensures config directories exist (via `ensureConfigDir()`). Call `ensureDefaultAccount()` separately at startup to auto-detect `~/.claude`.
- `DEFAULT_CLAUDE_DIR` is defined in `lib/config.js` and imported by `lib/keychain.js`. Do not redefine it elsewhere.
- The rate limit detector uses only one specific regex pattern (`RATE_LIMIT_PATTERN`). Do not add generic string matching — it causes false positives on conversational output containing words like "rate limit".
- `channel-map.json` lives at `~/.claude-nonstop/data/channel-map.json`, not in the project directory. The `channel-manager.cjs` has a one-time migration from the legacy `remote/data/` location.
- Signal handlers in `runner.js` use an idempotent `cleanup()` function guarded by a `cleaned` boolean to prevent double-kill or cleanup races.
- `node-pty` has a native dependency. If `npm install` fails, check that build tools (Xcode CLT on macOS, build-essential on Linux) are installed.

## Terminology

To avoid ambiguity, use these qualified terms in code comments and docs:

- **Claude session** — A Claude Code conversation (the `.jsonl` file and associated `tool-results/` directory)
- **tmux session** — The tmux terminal session created by `--remote-access`
- **Slack channel** — The per-session Slack channel (e.g., `#cn-myproject-abc12345`)
- **account** — A registered Claude subscription in `config.json` (not "profile," though accounts are stored under `profiles/`)

## Data Storage

All user data lives under `~/.claude-nonstop/`:

| Path | Purpose |
|------|---------|
| `config.json` | Account registry (`{accounts: [{name, configDir}]}`) |
| `.env` | Slack tokens (created by `setup`) |
| `data/channel-map.json` | Claude session-to-Slack channel mapping |
| `logs/webhook.log` | Webhook service log (macOS launchd) |
| `profiles/<name>/` | Isolated Claude Code config dirs per account |
| `profiles/<name>/settings.json` | Claude Code settings with hooks installed |

The webhook launchd plist lives at `~/Library/LaunchAgents/claude-nonstop-slack.plist` (macOS only).

The project directory should contain **no** user data, secrets, or runtime state.

## Three Execution Contexts

The codebase runs in three distinct contexts. Changes must respect which context the code runs in:

1. **CLI Process** (`bin/claude-nonstop.js` + `lib/`) — Long-lived main process. Spawns Claude Code via `node-pty`. Has access to ESM modules.
2. **Webhook Process** (`remote/start-webhook.cjs`) — Separate long-lived daemon. Connects to Slack via Socket Mode. CJS only.
3. **Hook Processes** (`remote/hook-notify.cjs`) — Short-lived, spawned by Claude Code on lifecycle events (session-start, completed) and by runner.js for progress/account-switch notifications. Reads stdin for hook context JSON. CJS only. Must start fast and exit quickly.

These processes communicate via `channel-map.json` (file-based IPC) and tmux. They do **not** share memory or direct IPC.

## Commit & Pull Request Guidelines

- Follow concise, action-oriented commit messages (e.g., "Add fetch timeout to usage API calls")
- Group related changes; avoid bundling unrelated refactors
- PRs should summarize scope, note testing performed, and mention any security implications

## Agent-Specific Notes

- When answering questions about the codebase, verify in source code; do not guess.
- After making code changes, always run `npm run check` to verify syntax.
- Do not modify `node_modules/` or native build artifacts (`build/`, `prebuilds/`).
- The `remote/data/` directory is gitignored (legacy location). Do not create files there.
- When modifying hook-related code, test with `claude-nonstop hooks status` to verify hook installation is still correct.
- `hook-notify.cjs` is called by Claude Code hooks (session-start, completed, tool-use) and by runner.js (account-switch). The runner.js-spawned calls are fire-and-forget with data on stdin.
- If adding a new CJS module to `remote/`, add it to the dependency graph in [DESIGN.md](DESIGN.md).
- If adding a new ESM module to `lib/`, add it to the dependency graph in [DESIGN.md](DESIGN.md).

## Setting Up claude-nonstop for a User

If you are an AI agent helping a user set up claude-nonstop, follow these steps exactly.

### Step 0: Determine scope

Ask the user what they need before starting:

- **Multi-account switching only** — Skip the Slack/webhook/remote-access steps entirely. The user only needs accounts added and can use `claude-nonstop`.
- **Slack remote access only** — The user may only have one account. Still need Slack setup, hooks, webhook, and tmux.
- **Both** — Full setup.

If the user just says "set up claude-nonstop" without details, ask which features they want.

### Step 1: Prerequisites check

```bash
node --version    # Must be >= 18.0.0
claude --version  # Claude Code CLI must be installed and in PATH
```

If `claude` is not found, the user must install Claude Code first: https://docs.anthropic.com/en/docs/claude-code/overview

Also check for C/C++ build tools (required by the `node-pty` native dependency):
- macOS: `xcode-select -p` should return a path (if not, run `xcode-select --install`)
- Linux: `dpkg -l build-essential` or `rpm -q gcc` depending on distro

For remote access features only:
```bash
tmux -V           # Any recent version
```

### Step 2: Install

If you are already inside the claude-nonstop repo directory, skip the clone:

```bash
# Only if not already cloned:
cd ~/code  # or user's preferred directory
git clone https://github.com/anthropics/claude-nonstop.git
cd claude-nonstop

npm install -g "$(npm pack)"
claude-nonstop help  # Verify
```

If `npm install -g` fails with compilation errors (gyp, node-pty), the user needs to install C/C++ build tools first. Tell them what to run for their platform and retry.

### Step 3: Add accounts

**The default account is automatic.** If the user already has Claude Code set up (`~/.claude` exists), it is auto-registered as "default" on first run. Verify with `claude-nonstop list`. Do not try to `add default` — it is handled automatically.

For multi-account switching, the user needs additional accounts (each must be a **different** Claude subscription with a different email). For each additional account:

**Duplicate protection:** If the user logs in with the same email as an existing account, claude-nonstop detects the duplicate after login, removes the new account, and exits with an error. You do not need to check for duplicates yourself.

**Agents can automate this step.** The `add` command uses `claude auth login` which opens the user's browser for OAuth and waits for completion — no interactive Claude session needed. You can run it directly:

```bash
claude-nonstop add <name>
```

This will open the user's browser. The user completes OAuth in the browser, and the command returns automatically once login succeeds.

**If running inside a Claude Code session**, the `CLAUDECODE` env var is stripped automatically so the nested-session check is bypassed. You can also split the operation into two steps if needed:

```bash
# Step 1: Register the account (no browser interaction)
node -e "import { addAccount } from './lib/config.js'; addAccount('<name>');"

# Step 2: Authenticate (opens browser, waits for OAuth)
unset CLAUDECODE && CLAUDE_CONFIG_DIR=~/.claude-nonstop/profiles/<name> claude auth login
```

**Wait for the login to complete** before proceeding — the browser OAuth must finish for credentials to be saved.

### Step 4: Verify accounts

```bash
claude-nonstop status
```

All accounts should show usage percentages with progress bars. If any show `error (HTTP 401)`, the user needs to re-authenticate with `claude-nonstop reauth`.

### Step 5: Permission mode

Ask the user if they want to enable bypass permissions mode. This sets `bypassPermissions` in `settings.json` for all profiles, so Claude Code runs without permission prompts (equivalent to `--dangerously-skip-permissions` on every invocation).

If the user agrees, read each profile's `settings.json`, set `permissions.defaultMode` to `"bypassPermissions"`, and write it back. For example:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

Apply this to all profiles:
- `~/.claude/settings.json` (default account)
- `~/.claude-nonstop/profiles/<name>/settings.json` (each additional account)

Use `jq` or read-modify-write to preserve existing settings (hooks, statusLine, etc.) — do not overwrite the file.

### Step 6: Configure Slack (if using remote access)

The user must first create a Slack app. Tell them:
> Go to https://api.slack.com/apps > Create New App > From a manifest. Paste the contents of `slack-manifest.yaml` from this repo, click Create, then Install to Workspace. Copy the **Bot Token** (xoxb-...) from OAuth & Permissions. Then generate an **App Token** (xapp-...): go to Basic Information > App-Level Tokens > Generate Token and Scopes, name it anything (e.g., "socket"), add the `connections:write` scope (this is the only scope needed — the manifest enables Socket Mode but cannot create this token automatically), and click Generate.

**Optional: Set the app icon.** The manifest cannot set the app icon — it must be uploaded manually. Tell the user:
> Go to Basic Information > Display Information > App Icon, and upload `assets/icon.jpeg` from the claude-nonstop repo. This gives the bot the Claude NonStop logo in Slack.

Next, tell the user to find their **Slack User ID**:
> Click your profile picture in Slack > Profile > click the three-dot menu (⋯) > Copy member ID. This starts with `U` (e.g., `U12345ABCDE`).

**Wait for the user to provide all three values** (bot token, app token, and user ID), then run:

```bash
claude-nonstop setup --bot-token <user-provided-bot-token> --app-token <user-provided-app-token> --invite-user-id <user-provided-slack-user-id>
```

The `--invite-user-id` flag is strongly recommended — without it, channels are created but the user is not auto-invited and Slack won't show them in the sidebar. The CLI accepts it as optional, but in practice users will not see their channels without it.

Or if you set them as environment variables:

```bash
export SLACK_BOT_TOKEN=<user-provided-bot-token>
export SLACK_APP_TOKEN=<user-provided-app-token>
export SLACK_INVITE_USER_ID=<user-provided-slack-user-id>
claude-nonstop setup --from-env
```

This writes `~/.claude-nonstop/.env`, installs hooks into all profiles, and auto-installs the webhook as a launchd service on macOS. No interactive prompts.

Optional overrides (ask the user if they want these):

```bash
claude-nonstop setup --bot-token <tok> --app-token <tok> --invite-user-id <uid> \
  --channel-prefix myprefix \
  --allowed-users U12345
```

### Step 7: Verify hooks

Hooks are installed automatically by `setup`. Verify:

```bash
claude-nonstop hooks status  # All should show "installed"
```

### Step 8: Verify webhook

On macOS, `setup` auto-installs the webhook as a launchd service. Verify it's running:

```bash
claude-nonstop webhook status
```

Expected output: `Status: running` with a PID. If the webhook isn't running, check logs with `claude-nonstop webhook logs`.

On Linux, start the webhook manually:

```bash
claude-nonstop webhook start
```

Expected output: `Slack bot is running in Socket Mode`. If it exits immediately, the tokens in `~/.claude-nonstop/.env` are likely wrong.

### Step 9: Verify end-to-end

```bash
claude-nonstop --remote-access
```

This should:
- Create a tmux session
- Select the best account
- Fire the SessionStart hook
- Create a Slack channel (e.g., `#cn-projectname-abc12345`)
- Claude's responses appear in the channel
- Messages in the channel are relayed to Claude

### What you CAN automate

- Installing claude-nonstop (`git clone`, `npm install -g "$(npm pack)"`)
- **Adding accounts** (`claude-nonstop add <name>`) — uses `claude auth login` which opens the browser and waits. The `CLAUDECODE` env var is stripped automatically so it works from inside a Claude Code session.
- Running `claude-nonstop setup --bot-token <tok> --app-token <tok> --invite-user-id <uid>` (after user provides tokens and user ID)
- Running `claude-nonstop setup --from-env` (after setting env vars with user-provided tokens and user ID)
- Installing hooks (`claude-nonstop hooks install`)
- Starting the webhook (`claude-nonstop webhook start` or `claude-nonstop webhook install` for launchd)
- Enabling `bypassPermissions` in profile settings.json files
- Uninstalling (`claude-nonstop uninstall --force`)

### What you CANNOT automate — must ask the user

- **Browser OAuth completion** — `claude auth login` opens the browser, but the user must complete the login flow there. Wait for the command to return.
- **Slack app creation** — requires browser interaction at api.slack.com. Tell the user what to do and wait for tokens. Note: the manifest enables Socket Mode but does **not** create the app-level token — the user must generate it manually (Basic Information > App-Level Tokens > Generate with `connections:write` scope).
- **Keychain access approval** — macOS may prompt on first credential read.
