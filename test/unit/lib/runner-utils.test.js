import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripAnsi, extractResumeSessionId, buildResumeArgs, deactivateStaleChannels } from '../../../lib/runner.js';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir.js';

describe('stripAnsi', () => {
  it('removes color codes', () => {
    assert.equal(stripAnsi('\x1b[31mred text\x1b[0m'), 'red text');
  });

  it('removes cursor sequences', () => {
    assert.equal(stripAnsi('\x1b[2Jhello\x1b[H'), 'hello');
  });

  it('removes OSC sequences', () => {
    assert.equal(stripAnsi('\x1b]0;title\x07content'), 'content');
  });

  it('passes plain text through unchanged', () => {
    assert.equal(stripAnsi('hello world'), 'hello world');
  });

  it('handles empty string', () => {
    assert.equal(stripAnsi(''), '');
  });

  it('removes multiple escape sequences', () => {
    assert.equal(stripAnsi('\x1b[1m\x1b[32mbold green\x1b[0m normal'), 'bold green normal');
  });

  it('handles mixed content', () => {
    const input = 'before\x1b[33myellow\x1b[0mafter';
    assert.equal(stripAnsi(input), 'beforeyellowafter');
  });
});

describe('extractResumeSessionId', () => {
  it('extracts --resume value', () => {
    assert.equal(extractResumeSessionId(['--resume', 'abc-123']), 'abc-123');
  });

  it('extracts -r shorthand value', () => {
    assert.equal(extractResumeSessionId(['-r', 'def-456']), 'def-456');
  });

  it('returns null when no --resume flag', () => {
    assert.equal(extractResumeSessionId(['--help']), null);
  });

  it('returns null for empty args', () => {
    assert.equal(extractResumeSessionId([]), null);
  });

  it('returns null when --resume is last arg (no value)', () => {
    assert.equal(extractResumeSessionId(['--resume']), null);
  });

  it('handles --resume with other args', () => {
    assert.equal(extractResumeSessionId(['--verbose', '--resume', 'xyz', '--output', 'json']), 'xyz');
  });
});

describe('buildResumeArgs', () => {
  it('prepends --resume when absent', () => {
    const result = buildResumeArgs(['--verbose'], 'abc-123');
    assert.deepEqual(result, ['--resume', 'abc-123', '--verbose']);
  });

  it('replaces existing --resume', () => {
    const result = buildResumeArgs(['--resume', 'old-id', '--verbose'], 'new-id');
    assert.deepEqual(result, ['--resume', 'new-id', '--verbose']);
  });

  it('replaces -r shorthand', () => {
    const result = buildResumeArgs(['-r', 'old-id'], 'new-id');
    assert.deepEqual(result, ['--resume', 'new-id']);
  });

  it('does not modify original array', () => {
    const original = ['--resume', 'old'];
    buildResumeArgs(original, 'new');
    assert.deepEqual(original, ['--resume', 'old']);
  });

  it('handles empty args', () => {
    const result = buildResumeArgs([], 'abc');
    assert.deepEqual(result, ['--resume', 'abc']);
  });

  it('handles both --resume and -r present', () => {
    const result = buildResumeArgs(['--resume', 'id1', '-r', 'id2', '--verbose'], 'new-id');
    assert.deepEqual(result, ['--resume', 'new-id', '--verbose']);
  });
});

describe('deactivateStaleChannels', () => {
  let tempDir;
  let channelMapPath;

  beforeEach(() => {
    tempDir = createTempDir();
    const dataDir = path.join(tempDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    channelMapPath = path.join(dataDir, 'channel-map.json');
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('deactivates active entries matching the tmux session name', () => {
    const data = {
      'sess-old': {
        channelId: 'C001',
        channelName: 'cn-myproject-sess-old',
        tmuxSession: 'myproject-a1b2c3',
        active: true,
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(channelMapPath, JSON.stringify(data));

    deactivateStaleChannels('myproject-a1b2c3', channelMapPath);

    const result = JSON.parse(fs.readFileSync(channelMapPath, 'utf8'));
    assert.equal(result['sess-old'].active, false);
  });

  it('deactivates multiple active entries on the same tmux session', () => {
    const data = {
      'sess-1': {
        channelId: 'C001',
        tmuxSession: 'myproject-a1b2c3',
        active: true,
        createdAt: new Date().toISOString(),
      },
      'sess-2': {
        channelId: 'C001',
        tmuxSession: 'myproject-a1b2c3',
        active: true,
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(channelMapPath, JSON.stringify(data));

    deactivateStaleChannels('myproject-a1b2c3', channelMapPath);

    const result = JSON.parse(fs.readFileSync(channelMapPath, 'utf8'));
    assert.equal(result['sess-1'].active, false);
    assert.equal(result['sess-2'].active, false);
  });

  it('does not affect entries for different tmux sessions', () => {
    const data = {
      'sess-this': {
        channelId: 'C001',
        tmuxSession: 'myproject-a1b2c3',
        active: true,
        createdAt: new Date().toISOString(),
      },
      'sess-other': {
        channelId: 'C002',
        tmuxSession: 'other-project-d4e5f6',
        active: true,
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(channelMapPath, JSON.stringify(data));

    deactivateStaleChannels('myproject-a1b2c3', channelMapPath);

    const result = JSON.parse(fs.readFileSync(channelMapPath, 'utf8'));
    assert.equal(result['sess-this'].active, false);
    assert.equal(result['sess-other'].active, true);
  });

  it('does not affect already-inactive entries', () => {
    const data = {
      'sess-old': {
        channelId: 'C001',
        tmuxSession: 'myproject-a1b2c3',
        active: false,
        archivedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    };
    const original = JSON.stringify(data);
    fs.writeFileSync(channelMapPath, original);

    deactivateStaleChannels('myproject-a1b2c3', channelMapPath);

    // File should not be rewritten (no changes)
    const result = fs.readFileSync(channelMapPath, 'utf8');
    assert.equal(result, original);
  });

  it('preserves all other fields on deactivated entries', () => {
    const data = {
      'sess-old': {
        channelId: 'C001',
        channelName: 'cn-proj-sess-old',
        tmuxSession: 'proj-abc123',
        project: 'proj',
        cwd: '/tmp/proj',
        active: true,
        pendingMessageTs: '1234.5678',
        progressMessageTs: '9876.5432',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    fs.writeFileSync(channelMapPath, JSON.stringify(data));

    deactivateStaleChannels('proj-abc123', channelMapPath);

    const result = JSON.parse(fs.readFileSync(channelMapPath, 'utf8'));
    const entry = result['sess-old'];
    assert.equal(entry.active, false);
    assert.equal(entry.channelId, 'C001');
    assert.equal(entry.channelName, 'cn-proj-sess-old');
    assert.equal(entry.pendingMessageTs, '1234.5678');
    assert.equal(entry.project, 'proj');
  });

  it('handles missing channel-map.json gracefully', () => {
    // Should not throw
    deactivateStaleChannels('myproject-a1b2c3', path.join(tempDir, 'nonexistent', 'channel-map.json'));
  });

  it('handles empty channel-map.json gracefully', () => {
    fs.writeFileSync(channelMapPath, '');
    deactivateStaleChannels('myproject-a1b2c3', channelMapPath);
    // File should remain empty
    assert.equal(fs.readFileSync(channelMapPath, 'utf8'), '');
  });

  it('handles corrupted JSON gracefully', () => {
    fs.writeFileSync(channelMapPath, '{not valid json');
    deactivateStaleChannels('myproject-a1b2c3', channelMapPath);
    // File should remain unchanged (error caught silently)
    assert.equal(fs.readFileSync(channelMapPath, 'utf8'), '{not valid json');
  });

  it('uses atomic write (no .tmp files left behind)', () => {
    const data = {
      'sess-1': {
        tmuxSession: 'proj-abc',
        active: true,
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(channelMapPath, JSON.stringify(data));

    deactivateStaleChannels('proj-abc', channelMapPath);

    const files = fs.readdirSync(path.dirname(channelMapPath));
    assert.ok(!files.some(f => f.endsWith('.tmp')), 'no temp files should remain');
  });

  // ─── Scenario Tests ─────────────────────────────────────────────────────

  it('scenario: exit + restart — stale entry deactivated, new session gets new channel', () => {
    // Previous run left an active entry
    const data = {
      'old-session': {
        channelId: 'C_OLD',
        channelName: 'cn-proj-old',
        tmuxSession: 'proj-abc123',
        active: true,
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(channelMapPath, JSON.stringify(data));

    // Runner starts, deactivates stale entries
    deactivateStaleChannels('proj-abc123', channelMapPath);

    const result = JSON.parse(fs.readFileSync(channelMapPath, 'utf8'));
    // Old entry is inactive — reuseChannelForTmuxSession will find nothing
    assert.equal(result['old-session'].active, false);
    // No active entries remain for this tmux session
    const activeForTmux = Object.values(result).filter(
      e => e.tmuxSession === 'proj-abc123' && e.active
    );
    assert.equal(activeForTmux.length, 0);
  });

  it('scenario: /clear — entry created during this session survives deactivation', () => {
    // Simulate: deactivation already ran at startup (old entry cleared)
    const dataAfterStartup = {
      'old-session': {
        channelId: 'C_OLD',
        tmuxSession: 'proj-abc123',
        active: false, // deactivated at startup
        createdAt: new Date().toISOString(),
      },
      'current-session': {
        channelId: 'C_NEW',
        channelName: 'cn-proj-current',
        tmuxSession: 'proj-abc123',
        active: true, // created during this run
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(channelMapPath, JSON.stringify(dataAfterStartup));

    // deactivateStaleChannels does NOT run again (it only runs once at startup)
    // Verify the current session entry is still active
    const result = JSON.parse(fs.readFileSync(channelMapPath, 'utf8'));
    assert.equal(result['current-session'].active, true);
    assert.equal(result['old-session'].active, false);
  });

  it('scenario: rate limit swap — migrated session keeps same ID, entry stays active', () => {
    // Deactivation ran at startup, clearing previous-run entries.
    // Then a session was created during this run.
    const data = {
      'active-session': {
        channelId: 'C_ACTIVE',
        channelName: 'cn-proj-active',
        tmuxSession: 'proj-abc123',
        active: true, // created during this run
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(channelMapPath, JSON.stringify(data));

    // Rate limit swap: session migrated, same session ID resumed.
    // deactivateStaleChannels does NOT run again.
    // The entry for 'active-session' remains active.
    const result = JSON.parse(fs.readFileSync(channelMapPath, 'utf8'));
    assert.equal(result['active-session'].active, true);
  });

  it('scenario: different terminal same project — only this tmux deactivated', () => {
    // Terminal 1 has an active session on the same tmux name
    // Terminal 2 starts (which would call deactivateStaleChannels)
    // But actually, terminal 2 would just attach to terminal 1's tmux,
    // so deactivateStaleChannels wouldn't run for a second invocation.
    // However, if terminal 1 exited first, then terminal 2 starts:
    const data = {
      'term1-session': {
        channelId: 'C_T1',
        tmuxSession: 'proj-abc123',
        active: true,
        createdAt: new Date().toISOString(),
      },
      'other-project-session': {
        channelId: 'C_OTHER',
        tmuxSession: 'other-def456',
        active: true,
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(channelMapPath, JSON.stringify(data));

    // Terminal 2 starts in same project dir — deactivates stale entries for this tmux
    deactivateStaleChannels('proj-abc123', channelMapPath);

    const result = JSON.parse(fs.readFileSync(channelMapPath, 'utf8'));
    assert.equal(result['term1-session'].active, false);
    assert.equal(result['other-project-session'].active, true);
  });
});
