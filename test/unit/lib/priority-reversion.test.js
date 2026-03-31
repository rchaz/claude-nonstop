import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRevertToPriority, pickBestAccount, REVERSION_THRESHOLD, PRIORITY_THRESHOLD } from '../../../lib/scorer.js';

/**
 * Tests for priority reversion logic.
 *
 * With --priority-revert, account selection at each rate-limit boundary
 * re-evaluates ALL accounts (no excludeName). If a higher-priority account
 * has recovered, pickBestAccount with usePriority naturally selects it.
 */

const makeAccount = (name, sessionPercent, weeklyPercent, opts = {}) => ({
  name,
  configDir: `/tmp/profiles/${name}`,
  token: 'token' in opts ? opts.token : 'sk-ant-oat01-valid',
  priority: opts.priority ?? undefined,
  usage: opts.error
    ? { error: opts.error }
    : { sessionPercent, weeklyPercent },
});

describe('priority reversion via pickBestAccount (no excludeName)', () => {
  it('picks recovered priority 1 over current priority 2', () => {
    const accounts = [
      makeAccount('main', 30, 30, { priority: 1 }),     // recovered
      makeAccount('backup', 40, 40, { priority: 2 }),    // current, also ok
    ];
    // With --priority-revert: excludeName=undefined
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'main');
  });

  it('stays on current if priority 1 is still exhausted', () => {
    const accounts = [
      makeAccount('main', PRIORITY_THRESHOLD, PRIORITY_THRESHOLD, { priority: 1 }),
      makeAccount('backup', 40, 40, { priority: 2 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'backup');
  });

  it('3 accounts: picks priority 2 when priority 1 exhausted', () => {
    const accounts = [
      makeAccount('a', 99, 99, { priority: 1 }),
      makeAccount('b', 40, 40, { priority: 2 }),
      makeAccount('c', 20, 20, { priority: 3 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'b');
  });

  it('3 accounts: both 1 and 2 recovered → picks priority 1', () => {
    const accounts = [
      makeAccount('a', 30, 30, { priority: 1 }),
      makeAccount('b', 20, 20, { priority: 2 }),
      makeAccount('c', 10, 10, { priority: 3 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'a');
  });

  it('same account selected when it is the best → no migration needed', () => {
    const accounts = [
      makeAccount('main', 99, 99, { priority: 1 }),   // exhausted
      makeAccount('backup', 40, 40, { priority: 2 }), // current & best
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'backup');
    // runner.js handles nextAccount.name === currentAccount.name by skipping migration
  });
});

describe('shouldRevertToPriority — decision function', () => {
  it('returns shouldRevert=true when a higher-priority account has recovered', () => {
    const current = { name: 'backup', priority: 2 };
    const accounts = [
      makeAccount('main', 40, 40, { priority: 1 }),
      makeAccount('backup', 30, 30, { priority: 2 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, true);
    assert.equal(result.betterAccount.name, 'main');
  });

  it('returns shouldRevert=false when current account has no priority', () => {
    const current = { name: 'nopri' };
    const accounts = [
      makeAccount('main', 20, 20, { priority: 1 }),
      makeAccount('nopri', 30, 30),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, false);
  });

  it('returns shouldRevert=false when current account is already priority 1', () => {
    const current = { name: 'main', priority: 1 };
    const accounts = [
      makeAccount('main', 20, 20, { priority: 1 }),
      makeAccount('backup', 10, 10, { priority: 2 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, false);
  });

  it('returns shouldRevert=false when higher-priority is above reversion threshold', () => {
    const current = { name: 'backup', priority: 2 };
    const accounts = [
      makeAccount('main', REVERSION_THRESHOLD, REVERSION_THRESHOLD, { priority: 1 }),
      makeAccount('backup', 30, 30, { priority: 2 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, false);
  });

  it('returns shouldRevert=false when higher-priority has error', () => {
    const current = { name: 'backup', priority: 2 };
    const accounts = [
      makeAccount('main', 0, 0, { priority: 1, error: 'HTTP 401' }),
      makeAccount('backup', 30, 30, { priority: 2 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, false);
  });

  it('picks best among multiple higher-priority candidates', () => {
    const current = { name: 'c', priority: 3 };
    const accounts = [
      makeAccount('a', 40, 40, { priority: 1 }),
      makeAccount('b', 30, 30, { priority: 2 }),
      makeAccount('c', 20, 20, { priority: 3 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, true);
    assert.equal(result.betterAccount.name, 'a');
  });

  it('does not trigger for equal priority', () => {
    const current = { name: 'b', priority: 2 };
    const accounts = [
      makeAccount('a', 10, 10, { priority: 2 }),
      makeAccount('b', 50, 50, { priority: 2 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, false);
  });
});

describe('priority reversion — multi-account lifecycle', () => {
  it('account 1 exhausted → use account 2 → account 1 recovers → revert', () => {
    const current = { name: 'account2', priority: 2 };

    // Phase 1: account 1 is exhausted
    const phase1 = [
      makeAccount('account1', 100, 100, { priority: 1 }),
      makeAccount('account2', 30, 30, { priority: 2 }),
    ];
    const r1 = shouldRevertToPriority(current, phase1);
    assert.equal(r1.shouldRevert, false);

    // Phase 2: account 1 recovers
    const phase2 = [
      makeAccount('account1', 0, 40, { priority: 1 }),
      makeAccount('account2', 50, 50, { priority: 2 }),
    ];
    const r2 = shouldRevertToPriority(current, phase2);
    assert.equal(r2.shouldRevert, true);
    assert.equal(r2.betterAccount.name, 'account1');
  });

  it('3 accounts, currently on 3, account 2 recovers (not 1)', () => {
    const current = { name: 'c', priority: 3 };
    const accounts = [
      makeAccount('a', 99, 99, { priority: 1 }),
      makeAccount('b', 40, 40, { priority: 2 }),
      makeAccount('c', 20, 20, { priority: 3 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, true);
    assert.equal(result.betterAccount.name, 'b');
  });
});
