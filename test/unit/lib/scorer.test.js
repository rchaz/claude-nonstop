import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickBestAccount, pickByPriority, PRIORITY_THRESHOLD } from '../../../lib/scorer.js';

describe('pickBestAccount', () => {
  const makeAccount = (name, sessionPercent, weeklyPercent, opts = {}) => ({
    name,
    configDir: `/tmp/profiles/${name}`,
    token: 'token' in opts ? opts.token : 'sk-ant-oat01-valid',
    priority: opts.priority ?? undefined,
    usage: opts.error
      ? { error: opts.error }
      : { sessionPercent, weeklyPercent },
  });

  it('picks the account with the lowest utilization', () => {
    const accounts = [
      makeAccount('high', 80, 50),
      makeAccount('low', 10, 20),
      makeAccount('mid', 40, 30),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'low');
  });

  it('uses the higher of session or weekly percent', () => {
    const accounts = [
      makeAccount('a', 10, 90),  // effective: 90
      makeAccount('b', 50, 20),  // effective: 50
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'b');
  });

  it('excludes the named account', () => {
    const accounts = [
      makeAccount('best', 0, 0),
      makeAccount('other', 50, 50),
    ];
    const result = pickBestAccount(accounts, 'best');
    assert.equal(result.account.name, 'other');
  });

  it('filters out accounts with no token', () => {
    const accounts = [
      makeAccount('no-token', 0, 0, { token: null }),
      makeAccount('has-token', 50, 50),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'has-token');
  });

  it('filters out accounts with usage errors', () => {
    const accounts = [
      makeAccount('error', 0, 0, { error: 'HTTP 401' }),
      makeAccount('ok', 60, 60),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'ok');
  });

  it('returns null when no candidates remain', () => {
    const accounts = [
      makeAccount('only', 0, 0, { token: null }),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result, null);
  });

  it('returns null for empty array', () => {
    const result = pickBestAccount([]);
    assert.equal(result, null);
  });

  it('returns null when all are excluded or invalid', () => {
    const accounts = [
      makeAccount('excluded', 0, 0),
      makeAccount('error', 0, 0, { error: 'timeout' }),
    ];
    const result = pickBestAccount(accounts, 'excluded');
    assert.equal(result, null);
  });

  it('handles tied utilization deterministically (first in input order wins)', () => {
    const accounts = [
      makeAccount('a', 50, 50),
      makeAccount('b', 50, 50),
    ];
    const result = pickBestAccount(accounts);
    assert.ok(result !== null);
    // Sort is stable in Node 18+; first candidate in input order wins ties
    assert.equal(result.account.name, 'a');
    // Verify it's consistent
    const result2 = pickBestAccount(accounts);
    assert.equal(result2.account.name, 'a');
  });

  it('includes reason string with percentages', () => {
    const accounts = [makeAccount('test', 25, 30)];
    const result = pickBestAccount(accounts);
    assert.ok(result.reason.includes('25%'));
    assert.ok(result.reason.includes('30%'));
  });

  it('handles accounts with null usage as 100% utilization', () => {
    const accounts = [
      { name: 'null-usage', configDir: '/tmp/null', token: 'sk-ant-oat01-x', usage: null },
      makeAccount('ok', 50, 50),
    ];
    // null usage -> effectiveUtilization returns 100, so 'ok' wins
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'ok');
  });

  it('handles zero utilization', () => {
    const accounts = [makeAccount('zero', 0, 0)];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'zero');
  });

  it('handles 100% utilization', () => {
    const accounts = [makeAccount('full', 100, 100)];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'full');
  });

  it('filters multiple invalid accounts correctly', () => {
    const accounts = [
      makeAccount('err1', 0, 0, { error: 'HTTP 500' }),
      makeAccount('err2', 0, 0, { error: 'timeout' }),
      makeAccount('no-tok', 0, 0, { token: null }),
      makeAccount('valid', 30, 40),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'valid');
  });

  // Without usePriority, priority is ignored
  it('ignores priority when usePriority is false (default)', () => {
    const accounts = [
      makeAccount('pri1', 80, 80, { priority: 1 }),  // effective: 80
      makeAccount('pri2', 10, 10, { priority: 2 }),   // effective: 10
    ];
    const result = pickBestAccount(accounts);
    // Default: lowest utilization wins, regardless of priority
    assert.equal(result.account.name, 'pri2');
  });
});

describe('pickBestAccount with usePriority', () => {
  const makeAccount = (name, sessionPercent, weeklyPercent, opts = {}) => ({
    name,
    configDir: `/tmp/profiles/${name}`,
    token: 'token' in opts ? opts.token : 'sk-ant-oat01-valid',
    priority: opts.priority ?? undefined,
    usage: opts.error
      ? { error: opts.error }
      : { sessionPercent, weeklyPercent },
  });

  it('picks highest priority account even with higher utilization', () => {
    const accounts = [
      makeAccount('main', 60, 60, { priority: 1 }),     // effective: 60
      makeAccount('backup', 10, 10, { priority: 2 }),    // effective: 10
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'main');
  });

  it('skips exhausted priority 1 and falls back to priority 2', () => {
    const accounts = [
      makeAccount('main', PRIORITY_THRESHOLD, PRIORITY_THRESHOLD, { priority: 1 }),
      makeAccount('backup', 10, 10, { priority: 2 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'backup');
  });

  it('skips account at 100% and uses next priority', () => {
    const accounts = [
      makeAccount('main', 100, 100, { priority: 1 }),
      makeAccount('backup', 50, 50, { priority: 2 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'backup');
  });

  it('accounts without priority are treated as lowest priority', () => {
    const accounts = [
      makeAccount('no-pri', 10, 10),                     // no priority = Infinity
      makeAccount('has-pri', 50, 50, { priority: 1 }),   // priority 1
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'has-pri');
  });

  it('same priority falls back to lower utilization', () => {
    const accounts = [
      makeAccount('a', 80, 80, { priority: 1 }),
      makeAccount('b', 20, 20, { priority: 1 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'b');
  });

  it('all exhausted — picks by priority then utilization', () => {
    const accounts = [
      makeAccount('a', 99, 99, { priority: 2 }),
      makeAccount('b', 98, 100, { priority: 1 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    // Both exhausted (>= 98%), priority 1 wins
    assert.equal(result.account.name, 'b');
  });

  it('excludeName still works with priority', () => {
    const accounts = [
      makeAccount('main', 10, 10, { priority: 1 }),
      makeAccount('backup', 50, 50, { priority: 2 }),
    ];
    const result = pickBestAccount(accounts, 'main', { usePriority: true });
    assert.equal(result.account.name, 'backup');
  });

  it('includes priority in reason string', () => {
    const accounts = [makeAccount('test', 25, 30, { priority: 1 })];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.ok(result.reason.includes('priority'));
    assert.ok(result.reason.includes('1'));
  });

  it('cascades through multiple priority levels', () => {
    const accounts = [
      makeAccount('main', 99, 99, { priority: 1 }),       // exhausted
      makeAccount('backup1', 99, 99, { priority: 2 }),     // exhausted
      makeAccount('backup2', 50, 50, { priority: 3 }),     // available
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'backup2');
  });
});

describe('pickByPriority', () => {
  const makeAccount = (name, sessionPercent, weeklyPercent, opts = {}) => ({
    name,
    configDir: `/tmp/profiles/${name}`,
    token: 'token' in opts ? opts.token : 'sk-ant-oat01-valid',
    priority: opts.priority ?? undefined,
    usage: opts.error
      ? { error: opts.error }
      : { sessionPercent, weeklyPercent },
  });

  it('is a convenience wrapper that uses priority', () => {
    const accounts = [
      makeAccount('main', 60, 60, { priority: 1 }),
      makeAccount('backup', 10, 10, { priority: 2 }),
    ];
    const result = pickByPriority(accounts);
    assert.equal(result.account.name, 'main');
  });

  it('returns null for empty array', () => {
    const result = pickByPriority([]);
    assert.equal(result, null);
  });
});

describe('PRIORITY_THRESHOLD', () => {
  it('is 98', () => {
    assert.equal(PRIORITY_THRESHOLD, 98);
  });
});
