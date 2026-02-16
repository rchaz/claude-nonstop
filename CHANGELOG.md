# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
