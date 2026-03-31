import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRevertToPriority, PRIORITY_THRESHOLD } from '../../../lib/scorer.js';

/**
 * Tests for the priority reversion polling mechanism.
 *
 * shouldRevertToPriority (scorer.js) is the core decision function.
 * startPriorityPollTimer (runner.js) calls it on a timer — tested via
 * integration-style tests that verify the signal/kill contract.
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

describe('priority reversion signal contract', () => {
  it('reversionSignal._kill is called when shouldRevert is true', () => {
    // Simulate what startPriorityPollTimer does: check shouldRevert, then call _kill
    const current = { name: 'backup', priority: 2 };
    const accounts = [
      makeAccount('main', 50, 50, { priority: 1 }),
      makeAccount('backup', 30, 30, { priority: 2 }),
    ];

    const reversionSignal = {};
    let killed = false;
    reversionSignal._kill = () => { killed = true; };

    const result = shouldRevertToPriority(current, accounts);
    if (result.shouldRevert) {
      reversionSignal.betterAccount = result.betterAccount;
      reversionSignal.reason = result.reason;
      reversionSignal._kill();
    }

    assert.equal(killed, true);
    assert.equal(reversionSignal.betterAccount.name, 'main');
    assert.ok(reversionSignal.reason.includes('recovered'));
  });

  it('reversionSignal._kill is not called when shouldRevert is false', () => {
    const current = { name: 'backup', priority: 2 };
    const accounts = [
      makeAccount('main', PRIORITY_THRESHOLD, PRIORITY_THRESHOLD, { priority: 1 }),
      makeAccount('backup', 30, 30, { priority: 2 }),
    ];

    const reversionSignal = {};
    let killed = false;
    reversionSignal._kill = () => { killed = true; };

    const result = shouldRevertToPriority(current, accounts);
    if (result.shouldRevert) {
      reversionSignal._kill();
    }

    assert.equal(killed, false);
  });

  it('handles _kill being null (already cleaned up by runOnce exit)', () => {
    const current = { name: 'backup', priority: 2 };
    const accounts = [
      makeAccount('main', 50, 50, { priority: 1 }),
      makeAccount('backup', 30, 30, { priority: 2 }),
    ];

    const reversionSignal = { _kill: null };
    const result = shouldRevertToPriority(current, accounts);
    if (result.shouldRevert) {
      // This should not throw even though _kill is null
      if (typeof reversionSignal._kill === 'function') {
        reversionSignal._kill();
      }
    }

    assert.equal(result.shouldRevert, true);
  });
});

describe('priority reversion — multi-account scenarios', () => {
  it('scenario: account 1 exhausted → use account 2 → account 1 recovers → revert', () => {
    const current = { name: 'account2', priority: 2 };

    // Phase 1: account 1 is exhausted, so we're on account 2
    const phase1 = [
      makeAccount('account1', 100, 100, { priority: 1 }),
      makeAccount('account2', 30, 30, { priority: 2 }),
    ];
    const r1 = shouldRevertToPriority(current, phase1);
    assert.equal(r1.shouldRevert, false, 'should not revert while account 1 is exhausted');

    // Phase 2: account 1 recovers (session reset)
    const phase2 = [
      makeAccount('account1', 0, 60, { priority: 1 }),  // session reset, weekly still high
      makeAccount('account2', 50, 50, { priority: 2 }),
    ];
    const r2 = shouldRevertToPriority(current, phase2);
    assert.equal(r2.shouldRevert, true, 'should revert after account 1 recovers');
    assert.equal(r2.betterAccount.name, 'account1');
  });

  it('scenario: 3 accounts, currently on 3, account 2 recovers (not 1)', () => {
    const current = { name: 'c', priority: 3 };
    const accounts = [
      makeAccount('a', 99, 99, { priority: 1 }),   // still exhausted
      makeAccount('b', 40, 40, { priority: 2 }),    // recovered
      makeAccount('c', 20, 20, { priority: 3 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, true);
    assert.equal(result.betterAccount.name, 'b');
  });

  it('scenario: 3 accounts, both 1 and 2 recover → picks priority 1', () => {
    const current = { name: 'c', priority: 3 };
    const accounts = [
      makeAccount('a', 30, 30, { priority: 1 }),
      makeAccount('b', 20, 20, { priority: 2 }),
      makeAccount('c', 10, 10, { priority: 3 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, true);
    assert.equal(result.betterAccount.name, 'a');
  });

  it('scenario: priority reversion does not trigger for equal priority', () => {
    const current = { name: 'b', priority: 2 };
    const accounts = [
      makeAccount('a', 10, 10, { priority: 2 }),   // same priority
      makeAccount('b', 50, 50, { priority: 2 }),
    ];
    const result = shouldRevertToPriority(current, accounts);
    assert.equal(result.shouldRevert, false);
  });
});
