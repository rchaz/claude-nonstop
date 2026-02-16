import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, extractResumeSessionId, buildResumeArgs } from '../../../lib/runner.js';

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
