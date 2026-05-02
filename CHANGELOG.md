# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`swap <target>` command** — ergonomic mid-session account swap precursor.
  A running Claude Code process loads OAuth credentials at startup and cannot
  swap them in-place; the proper procedure is exit → `use <target>` →
  `resume <id> --account=<target>`. `swap` does the validation up front
  (target exists, has token, quota previewed) and auto-detects the current
  session id for the cwd, then prints the exact `resume` 1-liner to paste
  after exit. Catches typos / missing creds BEFORE the user kills their
  active session.
  - `--session=<id>` to override session auto-detection
  - `--quiet` to print only the resume command (script-friendly, e.g. `swap fourth --quiet | pbcopy`)

## [0.2.0] - 2025-06-15

### Added

- Multi-account switching with automatic rate limit detection
- Slack remote access with per-session channels
- Account management commands (`add`, `remove`, `list`, `status`, `reauth`)
- Claude Code hook integration (`SessionStart`, `Stop`)
- Socket Mode webhook for Slack message relay
- Session migration between accounts (`.jsonl` + `tool-results/`)
- Usage API integration with best-account scoring
- tmux session management for remote access
- Interactive `setup` command for Slack configuration
- Hook installation and status commands

### Security

- Account name validation — alphanumeric, hyphens, underscores only; path traversal blocked (prevents malicious names like `../etc`)
- Command injection prevention — all subprocess calls use `execFile` with array arguments, never shell string interpolation
- Tmux message length truncation — 4096 char limit prevents terminal flooding from Slack relay
- User data isolation — all runtime data stored in `~/.claude-nonstop/`, not in the project directory
- Atomic writes for `channel-map.json` — write-to-temp + rename prevents corruption from concurrent access
- Stale channel-map entry pruning — inactive entries auto-removed after 7 days to limit data accumulation

## [0.1.0] - 2025-05-01

### Added

- Initial implementation
- Basic account switching
- Slack integration prototype
