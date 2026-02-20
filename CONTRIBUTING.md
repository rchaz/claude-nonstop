# Contributing to claude-nonstop

Thanks for your interest in contributing! This document covers how to get started.

## Quick Links

- [Issues](https://github.com/rchaz/claude-nonstop/issues)
- [README](README.md)
- [Design Document](DESIGN.md) — architecture, data flow, and security model

## Reporting Bugs

Open an issue with:

1. What you expected to happen
2. What actually happened
3. Steps to reproduce
4. Your environment (OS, Node.js version, Claude Code version)

## Suggesting Features

Open an issue describing the use case and proposed solution. For larger changes, open a discussion first.

## Development Setup

```bash
git clone https://github.com/rchaz/claude-nonstop.git
cd claude-nonstop
npm install -g "$(npm pack)"
```

### Prerequisites

- Node.js 22+ (24 LTS recommended)
- C/C++ build tools (for compiling `node-pty`): Xcode CLT on macOS, `build-essential` on Linux
- Claude Code CLI installed
- tmux (only needed if testing remote access features)

### Running

```bash
claude-nonstop help          # Verify install
claude-nonstop list          # Check accounts
claude-nonstop status        # Check usage
```

### Verifying Changes

After making changes, verify syntax:

```bash
npm run check                # Runs node --check on all source files
```

Or individually:

```bash
node --check lib/*.js
node --check remote/*.cjs
node --check bin/claude-nonstop.js
node --check scripts/postinstall.js
```

Then verify basic functionality:

```bash
claude-nonstop help
claude-nonstop list
claude-nonstop status   # Requires at least one account
```

### Testing Multi-Account Switching

You need 2+ accounts with different Claude subscriptions. To test rate limit detection without hitting a real limit, check that the regex matches:

```bash
node -e "
  const p = /Limit reached\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im;
  console.log(p.test('Limit reached · resets in 2h 30m'));  // true
"
```

### Testing Slack Integration

1. Create a test Slack app (or use your existing one)
2. Run `claude-nonstop setup` with your tokens
3. Verify hooks: `claude-nonstop hooks status`
4. Start webhook in foreground for debugging: `claude-nonstop webhook start`
5. Run `claude-nonstop --remote-access` and check that a Slack channel is created

### Debugging

- **Webhook logs (macOS):** `claude-nonstop webhook logs` or `cat ~/.claude-nonstop/logs/webhook.log`
- **Webhook logs (foreground):** Run `claude-nonstop webhook start` — output goes to stdout
- **Hook failures:** Hooks are fire-and-forget. Check webhook logs for Slack API errors. Add `console.error()` to `remote/hook-notify.cjs` for debugging.
- **Channel map state:** `cat ~/.claude-nonstop/data/channel-map.json`
- **Account credentials:** `claude-nonstop list` shows auth status; `claude-nonstop status` tests the API

## Project Structure

- `bin/` -- CLI entry point and command routing
- `lib/` -- Core logic (ESM modules)
- `remote/` -- Slack remote access subsystem (CJS modules)

The `lib/` directory uses ESM (`import/export`). The `remote/` directory uses CJS (`require/module.exports`) because Claude Code spawns hook scripts as standalone Node.js processes. See [DESIGN.md](DESIGN.md#process-model) for the full architecture.

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run check` to verify syntax
4. Open a PR with a clear description of the change and motivation

### Code Style

- Use `const` over `let` where possible
- Use descriptive variable names
- Keep functions focused and small
- Follow existing patterns in the codebase
- No TypeScript — this is a plain Node.js project
- See the Security Rules in [CLAUDE.md](CLAUDE.md#security-rules) — these are hard requirements

### Commit Messages

Use clear, descriptive commit messages:

```
Add fetch timeout to usage API calls

Prevents indefinite hangs when the Anthropic API is unreachable.
AbortController with 10s timeout on both checkUsage() and fetchProfile().
```

## Note on `postinstall`

Running `npm install` executes `scripts/postinstall.js`, which restarts the webhook launchd service on macOS if it's already installed. This is a no-op on fresh installs and on Linux. It will never cause `npm install` to fail.

## AI-Assisted Contributions

AI-assisted PRs are welcome. If you used AI tools to help write code, mention it in the PR description for transparency.

## Security

If you discover a security vulnerability, please report it privately. See [SECURITY.md](SECURITY.md) for details.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
