# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in claude-nonstop, please report it responsibly.

**Do not open a public issue.** Instead, use [GitHub's private vulnerability reporting](https://github.com/rchaz/claude-nonstop/security/advisories/new) to submit your report directly.

Include:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if you have one)

You should receive a response within 7 days.

## Scope

### In Scope

- Command injection via account names, session IDs, or Slack messages
- OAuth token leakage or exposure
- Path traversal in account management or session migration
- Unauthorized access to tmux sessions via Slack relay
- Slack token exposure in logs or error messages

### Out of Scope

- Issues requiring physical access to the machine
- Social engineering attacks
- Denial of service against the Anthropic API (rate limits are expected)
- Vulnerabilities in Claude Code itself (report those to Anthropic)
- Vulnerabilities in Slack's API or platform

## Security Model

claude-nonstop handles sensitive credentials. See [DESIGN.md](DESIGN.md#security-model) for the full security model, including:

- **Credential handling** -- OAuth tokens are read-only from OS credential stores; never cached or written
- **Trust boundaries** -- Keychain, Slack, tmux, and file-based IPC boundaries
- **Injection mitigations** -- `execFile` over shell strings, literal tmux send-keys, input validation, message truncation

## Revoking Leaked Tokens

If you suspect a token has been leaked:

- **Anthropic OAuth tokens** (`sk-ant-oat01-*`): Log out via `claude auth logout` for the affected account, then re-authenticate with `claude-nonstop reauth`. The old token is invalidated on logout.
- **Slack Bot Token** (`xoxb-*`): Go to your Slack app's **OAuth & Permissions** page and click **Revoke Tokens**, then reinstall the app to generate a new token. Update `~/.claude-nonstop/.env` and restart the webhook.
- **Slack App Token** (`xapp-*`): Go to **Basic Information > App-Level Tokens**, revoke the token, and generate a new one. Update `~/.claude-nonstop/.env` and restart the webhook.

## Data at Uninstall

Running `claude-nonstop uninstall` removes:

- `~/.claude-nonstop/` (config, `.env`, channel-map, logs, profiles)
- Webhook launchd service (macOS)
- Claude Code hooks from all profile `settings.json` files
- The global npm link

It does **not** remove OAuth credentials from the OS keychain. To remove those, use `claude auth logout` for each account before uninstalling.

## Hardening

- Store Slack tokens in `~/.claude-nonstop/.env` (not in the project directory)
- Use `SLACK_ALLOWED_USERS` to restrict who can send commands via Slack
- Run the webhook process under a dedicated user if possible
- Keep Node.js updated (22+ required, 24 LTS recommended)
- Review `~/.claude-nonstop/data/channel-map.json` periodically -- stale entries are auto-pruned after 7 days
