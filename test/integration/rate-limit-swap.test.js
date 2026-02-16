import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { createTempDir, removeTempDir } from '../helpers/temp-dir.js';
import { extractResumeSessionId, buildResumeArgs, RATE_LIMIT_PATTERN, stripAnsi } from '../../lib/runner.js';
import { checkAllUsage } from '../../lib/usage.js';
import { pickBestAccount } from '../../lib/scorer.js';
import { findLatestSession, migrateSession, getCwdHash } from '../../lib/session.js';

// Simulates the swap loop from runner.run() using pre-fabricated runOnce results.
// Tests the orchestration logic without PTY/stdin/stdout dependencies.
function simulateSwapLoop({
  claudeArgs,
  currentAccount,
  allAccountsWithUsage,
  cwd,
  maxSwaps = 5,
  runOnceResults, // Array of { exitCode, rateLimitDetected, resetTime, sessionId }
}) {
  let swapCount = 0;
  let sessionId = extractResumeSessionId(claudeArgs);
  const swapLog = [];

  for (const result of runOnceResults) {
    // Normal exit
    if (result.exitCode !== null && !result.rateLimitDetected) {
      return { exitCode: result.exitCode, swapLog, finalAccount: currentAccount, finalArgs: claudeArgs };
    }

    if (!result.rateLimitDetected) {
      return { exitCode: result.exitCode ?? 1, swapLog, finalAccount: currentAccount, finalArgs: claudeArgs };
    }

    // Rate limit — attempt swap
    swapCount++;

    if (swapCount > maxSwaps) {
      return { exitCode: 1, swapLog, error: 'max_swaps_reached', finalAccount: currentAccount, finalArgs: claudeArgs };
    }

    // Find session to migrate
    const session = result.sessionId
      ? { sessionId: result.sessionId }
      : findLatestSession(currentAccount.configDir, cwd);

    // Pick next best account
    const best = pickBestAccount(allAccountsWithUsage, currentAccount.name);

    if (!best) {
      return { exitCode: 1, swapLog, error: 'no_alternative_accounts', finalAccount: currentAccount, finalArgs: claudeArgs };
    }

    const nextAccount = best.account;

    // Migrate session if we have one
    let migrated = false;
    if (session) {
      const migration = migrateSession(
        currentAccount.configDir,
        nextAccount.configDir,
        cwd,
        session.sessionId
      );
      if (migration.success) {
        sessionId = session.sessionId;
        migrated = true;
      } else {
        sessionId = null;
      }
    } else {
      sessionId = null;
    }

    // Update args
    if (sessionId) {
      claudeArgs = buildResumeArgs(claudeArgs, sessionId);
    }

    swapLog.push({
      from: currentAccount.name,
      to: nextAccount.name,
      sessionMigrated: migrated,
      sessionId,
      reason: best.reason,
    });

    // Update for next iteration
    currentAccount = nextAccount;
    // Remove the swapped-from account from candidates for next round
    allAccountsWithUsage = allAccountsWithUsage.map(a =>
      a.name === swapLog[swapLog.length - 1].from
        ? { ...a, usage: { error: 'rate-limited' } }
        : a
    );
  }

  return { exitCode: 0, swapLog, finalAccount: currentAccount, finalArgs: claudeArgs };
}

describe('rate limit swap loop', () => {
  let tempDir;
  const SESSION_ID = 'fade1234-5678-9abc-def0-123456789abc';
  const CWD = '/Users/test/code/myproject';

  function makeAccount(name, sessionPercent, weeklyPercent) {
    const configDir = join(tempDir, `profile-${name}`);
    return {
      name,
      configDir,
      token: `sk-ant-oat01-${name}`,
      usage: { sessionPercent, weeklyPercent, error: null },
    };
  }

  function setupSessionFiles(account, sessionId, content = '{"type":"test"}\n') {
    const hash = getCwdHash(CWD);
    const projectDir = join(account.configDir, 'projects', hash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), content);

    // Also create tool-results directory
    const toolDir = join(projectDir, sessionId);
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, 'result-1.json'), '{"status":"ok"}');

    return projectDir;
  }

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('single rate limit → switches to best account and migrates session', () => {
    const acctA = makeAccount('primary', 95, 80);
    const acctB = makeAccount('secondary', 20, 15);
    const acctC = makeAccount('tertiary', 50, 40);

    // Set up session files in primary account
    setupSessionFiles(acctA, SESSION_ID);

    const result = simulateSwapLoop({
      claudeArgs: ['-p', 'do something'],
      currentAccount: acctA,
      allAccountsWithUsage: [acctA, acctB, acctC],
      cwd: CWD,
      runOnceResults: [
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 2h', sessionId: SESSION_ID },
        { exitCode: 0, rateLimitDetected: false, resetTime: null, sessionId: SESSION_ID },
      ],
    });

    // Should have swapped once
    assert.equal(result.swapLog.length, 1);
    assert.equal(result.swapLog[0].from, 'primary');
    assert.equal(result.swapLog[0].to, 'secondary'); // lowest utilization
    assert.equal(result.swapLog[0].sessionMigrated, true);
    assert.equal(result.swapLog[0].sessionId, SESSION_ID);

    // Final account should be secondary
    assert.equal(result.finalAccount.name, 'secondary');

    // Args should include --resume
    assert.ok(result.finalArgs.includes('--resume'));
    assert.ok(result.finalArgs.includes(SESSION_ID));

    // Session file should exist in secondary account's config dir
    const hash = getCwdHash(CWD);
    const destSession = join(acctB.configDir, 'projects', hash, `${SESSION_ID}.jsonl`);
    assert.ok(existsSync(destSession), 'session file should be migrated');

    // Tool results should also be migrated
    const destToolResults = join(acctB.configDir, 'projects', hash, SESSION_ID, 'result-1.json');
    assert.ok(existsSync(destToolResults), 'tool results should be migrated');

    // Content should be identical
    const srcContent = readFileSync(join(acctA.configDir, 'projects', hash, `${SESSION_ID}.jsonl`), 'utf8');
    const dstContent = readFileSync(destSession, 'utf8');
    assert.equal(srcContent, dstContent);
  });

  it('cascading rate limits → chains through multiple accounts', () => {
    const acctA = makeAccount('alpha', 95, 90);
    const acctB = makeAccount('beta', 30, 25);
    const acctC = makeAccount('gamma', 50, 45);

    setupSessionFiles(acctA, SESSION_ID);

    const result = simulateSwapLoop({
      claudeArgs: ['-p', 'build the feature'],
      currentAccount: acctA,
      allAccountsWithUsage: [acctA, acctB, acctC],
      cwd: CWD,
      runOnceResults: [
        // alpha hits rate limit
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 2h', sessionId: SESSION_ID },
        // beta also hits rate limit
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 1h', sessionId: SESSION_ID },
        // gamma succeeds
        { exitCode: 0, rateLimitDetected: false, resetTime: null, sessionId: SESSION_ID },
      ],
    });

    assert.equal(result.swapLog.length, 2);

    // First swap: alpha → beta (lowest util excluding alpha)
    assert.equal(result.swapLog[0].from, 'alpha');
    assert.equal(result.swapLog[0].to, 'beta');
    assert.equal(result.swapLog[0].sessionMigrated, true);

    // Second swap: beta → gamma (only remaining)
    assert.equal(result.swapLog[1].from, 'beta');
    assert.equal(result.swapLog[1].to, 'gamma');
    assert.equal(result.swapLog[1].sessionMigrated, true);

    assert.equal(result.finalAccount.name, 'gamma');
    assert.equal(result.exitCode, 0);

    // Session should exist in gamma's config dir
    const hash = getCwdHash(CWD);
    const gammaSession = join(acctC.configDir, 'projects', hash, `${SESSION_ID}.jsonl`);
    assert.ok(existsSync(gammaSession), 'session should be migrated to gamma');
  });

  it('max swaps reached → returns error', () => {
    const acctA = makeAccount('a', 90, 90);
    const acctB = makeAccount('b', 80, 80);
    const acctC = makeAccount('c', 70, 70);
    const acctD = makeAccount('d', 60, 60);

    setupSessionFiles(acctA, SESSION_ID);

    // maxSwaps=2 means only 2 swaps are allowed.
    // 3 rate limits in a row will exhaust the swap budget.
    const result = simulateSwapLoop({
      claudeArgs: ['-p', 'task'],
      currentAccount: acctA,
      allAccountsWithUsage: [acctA, acctB, acctC, acctD],
      cwd: CWD,
      maxSwaps: 2,
      runOnceResults: [
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 5h', sessionId: SESSION_ID },
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 4h', sessionId: SESSION_ID },
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 3h', sessionId: SESSION_ID },
      ],
    });

    assert.equal(result.error, 'max_swaps_reached');
    assert.equal(result.exitCode, 1);
    assert.equal(result.swapLog.length, 2); // exactly 2 swaps before giving up
  });

  it('no alternative accounts → returns error', () => {
    const acctA = makeAccount('solo', 90, 90);

    setupSessionFiles(acctA, SESSION_ID);

    const result = simulateSwapLoop({
      claudeArgs: ['-p', 'task'],
      currentAccount: acctA,
      allAccountsWithUsage: [acctA], // Only one account
      cwd: CWD,
      runOnceResults: [
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 2h', sessionId: SESSION_ID },
      ],
    });

    assert.equal(result.error, 'no_alternative_accounts');
    assert.equal(result.exitCode, 1);
  });

  it('normal exit → no swaps attempted', () => {
    const acctA = makeAccount('main', 50, 50);
    const acctB = makeAccount('backup', 20, 20);

    const result = simulateSwapLoop({
      claudeArgs: ['-p', 'hello'],
      currentAccount: acctA,
      allAccountsWithUsage: [acctA, acctB],
      cwd: CWD,
      runOnceResults: [
        { exitCode: 0, rateLimitDetected: false, resetTime: null, sessionId: null },
      ],
    });

    assert.equal(result.swapLog.length, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.finalAccount.name, 'main');
  });

  it('preserves existing --resume arg through swap', () => {
    const acctA = makeAccount('a', 90, 90);
    const acctB = makeAccount('b', 10, 10);

    setupSessionFiles(acctA, SESSION_ID);

    const result = simulateSwapLoop({
      claudeArgs: ['--resume', SESSION_ID, '--verbose'],
      currentAccount: acctA,
      allAccountsWithUsage: [acctA, acctB],
      cwd: CWD,
      runOnceResults: [
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 1h', sessionId: SESSION_ID },
        { exitCode: 0, rateLimitDetected: false, resetTime: null, sessionId: SESSION_ID },
      ],
    });

    // Session should be preserved
    assert.equal(result.swapLog[0].sessionId, SESSION_ID);
    assert.ok(result.finalArgs.includes('--resume'));
    assert.ok(result.finalArgs.includes(SESSION_ID));
    assert.ok(result.finalArgs.includes('--verbose'));
  });

  it('handles missing session gracefully (starts fresh)', () => {
    const acctA = makeAccount('a', 90, 90);
    const acctB = makeAccount('b', 10, 10);
    // No session files created

    const result = simulateSwapLoop({
      claudeArgs: ['-p', 'task'],
      currentAccount: acctA,
      allAccountsWithUsage: [acctA, acctB],
      cwd: CWD,
      runOnceResults: [
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 2h', sessionId: null },
        { exitCode: 0, rateLimitDetected: false, resetTime: null, sessionId: null },
      ],
    });

    assert.equal(result.swapLog.length, 1);
    assert.equal(result.swapLog[0].from, 'a');
    assert.equal(result.swapLog[0].to, 'b');
    assert.equal(result.swapLog[0].sessionMigrated, false);
    assert.equal(result.swapLog[0].sessionId, null);
    assert.equal(result.exitCode, 0);
  });

  it('skips accounts with errors during cascading swap', () => {
    const acctA = makeAccount('a', 90, 90);
    const acctB = { ...makeAccount('b', 10, 10), usage: { error: 'HTTP 401' } };
    const acctC = makeAccount('c', 30, 30);

    setupSessionFiles(acctA, SESSION_ID);

    const result = simulateSwapLoop({
      claudeArgs: ['-p', 'task'],
      currentAccount: acctA,
      allAccountsWithUsage: [acctA, acctB, acctC],
      cwd: CWD,
      runOnceResults: [
        { exitCode: null, rateLimitDetected: true, resetTime: 'in 2h', sessionId: SESSION_ID },
        { exitCode: 0, rateLimitDetected: false, resetTime: null, sessionId: SESSION_ID },
      ],
    });

    // Should skip errored account 'b' and go straight to 'c'
    assert.equal(result.swapLog[0].to, 'c');
  });
});

describe('rate limit detection + scoring pipeline', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('full pipeline: detect pattern → check usage → pick best → verify exclusion', async () => {
    // Step 1: Simulate rate limit detection from PTY output
    const ptyOutput = 'Some output here\nLimit reached · resets in 2h 30m\n';
    const stripped = stripAnsi(ptyOutput);
    const match = RATE_LIMIT_PATTERN.exec(stripped);
    assert.ok(match, 'rate limit should be detected');

    // Step 2: Mock usage API — the rate-limited account has high utilization
    globalThis.fetch = async (url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      const data = {
        'sk-ant-oat01-rate-limited': { five_hour: { utilization: 0.99 }, seven_day: { utilization: 0.85 } },
        'sk-ant-oat01-fresh': { five_hour: { utilization: 0.05 }, seven_day: { utilization: 0.10 } },
        'sk-ant-oat01-moderate': { five_hour: { utilization: 0.40 }, seven_day: { utilization: 0.30 } },
      };
      return { ok: true, json: async () => data[token] || {} };
    };

    const accounts = [
      { name: 'rate-limited', configDir: '/tmp/rl', token: 'sk-ant-oat01-rate-limited' },
      { name: 'fresh', configDir: '/tmp/fresh', token: 'sk-ant-oat01-fresh' },
      { name: 'moderate', configDir: '/tmp/mod', token: 'sk-ant-oat01-moderate' },
    ];

    // Step 3: Check usage for all accounts
    const withUsage = await checkAllUsage(accounts);

    // Step 4: Pick best, excluding the rate-limited one
    const best = pickBestAccount(withUsage, 'rate-limited');

    assert.ok(best !== null, 'should find an alternative');
    assert.equal(best.account.name, 'fresh');
    assert.ok(best.reason.includes('5%'), 'reason should mention session percent');
    assert.ok(best.reason.includes('10%'), 'reason should mention weekly percent');
  });

  it('all accounts rate-limited → returns null', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ five_hour: { utilization: 1.0 }, seven_day: { utilization: 0.95 } }),
    });

    const accounts = [
      { name: 'a', configDir: '/tmp/a', token: 'sk-ant-oat01-a' },
      { name: 'b', configDir: '/tmp/b', token: 'sk-ant-oat01-b' },
    ];

    const withUsage = await checkAllUsage(accounts);

    // Both have valid usage (no errors), but we exclude 'a' — 'b' is still picked
    // even at 100% because it has no usage error
    const best = pickBestAccount(withUsage, 'a');
    assert.ok(best !== null, 'b still has valid usage even at 100%');
    assert.equal(best.account.name, 'b');

    // But if all have errors, null is returned
    const errorAccounts = [
      { name: 'x', configDir: '/tmp/x', token: 'sk-ant-oat01-x', usage: { error: 'HTTP 429' } },
      { name: 'y', configDir: '/tmp/y', token: 'sk-ant-oat01-y', usage: { error: 'timeout' } },
    ];
    const noBest = pickBestAccount(errorAccounts, 'x');
    assert.equal(noBest, null);
  });
});
