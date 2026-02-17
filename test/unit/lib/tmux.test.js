import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'path';
import { isInsideTmux, generateSessionName, getCurrentTmuxSession } from '../../../lib/tmux.js';

describe('isInsideTmux', () => {
  let origTmux;

  beforeEach(() => {
    origTmux = process.env.TMUX;
  });

  afterEach(() => {
    if (origTmux !== undefined) {
      process.env.TMUX = origTmux;
    } else {
      delete process.env.TMUX;
    }
  });

  it('returns true when TMUX env var is set', () => {
    process.env.TMUX = '/tmp/tmux-501/default,12345,0';
    assert.equal(isInsideTmux(), true);
  });

  it('returns false when TMUX env var is not set', () => {
    delete process.env.TMUX;
    assert.equal(isInsideTmux(), false);
  });

  it('returns false when TMUX is empty string', () => {
    process.env.TMUX = '';
    assert.equal(isInsideTmux(), false);
  });
});

describe('generateSessionName', () => {
  it('produces basename-hash format', () => {
    const name = generateSessionName();
    assert.match(name, /^.+-[a-f0-9]{6}$/);
  });

  it('is deterministic when no tmux sessions exist', () => {
    // When no sessions exist, both calls return the base name
    const name1 = generateSessionName();
    const name2 = generateSessionName();
    assert.equal(name1, name2);
  });

  it('starts with the basename of cwd', () => {
    const expected = basename(process.cwd());
    assert.ok(generateSessionName().startsWith(expected));
  });
});

describe('getCurrentTmuxSession', () => {
  it('returns a string or null', () => {
    const result = getCurrentTmuxSession();
    // Returns a non-empty string when inside tmux, null otherwise
    if (result !== null) {
      assert.equal(typeof result, 'string');
      assert.ok(result.length > 0);
    } else {
      assert.equal(result, null);
    }
  });
});
