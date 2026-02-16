import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_LIMIT_PATTERN, stripAnsi, findEarliestReset, formatDuration, sleep, EXHAUSTION_THRESHOLD, MAX_SLEEP_MS } from '../../../lib/runner.js';
import { effectiveUtilization } from '../../../lib/scorer.js';

describe('RATE_LIMIT_PATTERN', () => {
  // ── Should match ─────────────────────────────────────────────────────

  it('matches "Limit reached · resets in 2h 30m"', () => {
    const input = 'Limit reached · resets in 2h 30m';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.ok(match, 'pattern should match');
    assert.equal(match[1].trim(), 'in 2h 30m');
  });

  it('matches "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"', () => {
    const input = 'Limit reached · resets Dec 17 at 6am (Europe/Oslo)';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.ok(match, 'pattern should match');
    assert.equal(match[1].trim(), 'Dec 17 at 6am (Europe/Oslo)');
  });

  it('matches with bullet • instead of ·', () => {
    const input = 'Limit reached • resets in 1h 15m';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.ok(match, 'pattern should match bullet variant');
    assert.equal(match[1].trim(), 'in 1h 15m');
  });

  it('matches with extra whitespace around separator', () => {
    const input = 'Limit reached   ·   resets in 45m';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.ok(match, 'pattern should tolerate extra whitespace');
  });

  it('matches case-insensitively', () => {
    const input = 'limit reached · resets in 3h';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.ok(match, 'pattern should be case insensitive');
  });

  it('matches when embedded in multi-line output', () => {
    const input = [
      'Some previous output here...',
      'Working on task...',
      'Limit reached · resets Feb 16 at 2pm (US/Pacific)',
      '',
    ].join('\n');
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.ok(match, 'pattern should match in multi-line text');
    assert.equal(match[1].trim(), 'Feb 16 at 2pm (US/Pacific)');
  });

  it('matches at end of string (no trailing newline)', () => {
    const input = 'Limit reached · resets in 5h';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.ok(match, 'pattern should match at string end');
  });

  it('matches after ANSI stripping of colored output', () => {
    const colored = '\x1b[1m\x1b[31mLimit reached\x1b[0m \x1b[2m·\x1b[0m \x1b[2mresets in 2h 30m\x1b[0m';
    const stripped = stripAnsi(colored);
    const match = RATE_LIMIT_PATTERN.exec(stripped);
    assert.ok(match, 'pattern should match after ANSI stripping');
  });

  // ── Should NOT match (false positives) ────────────────────────────────

  it('does not match conversational text about rate limits', () => {
    const input = 'The rate limit was reached earlier today';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.equal(match, null, 'should not match conversational text');
  });

  it('does not match partial pattern without "resets"', () => {
    const input = 'Limit reached · please wait';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.equal(match, null, 'should not match without "resets"');
  });

  it('does not match "Limit" alone', () => {
    const input = 'You have reached the limit of your plan';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.equal(match, null);
  });

  it('does not match code containing the word "Limit"', () => {
    const input = 'const RATE_LIMIT = 100; // resets every hour';
    const match = RATE_LIMIT_PATTERN.exec(input);
    assert.equal(match, null);
  });
});

describe('rolling buffer + pattern detection simulation', () => {
  const OUTPUT_BUFFER_MAX = 4000;
  const OUTPUT_BUFFER_TRIM = 2000;

  /**
   * Simulates the rolling buffer logic from runOnce().
   * Feeds chunks into a buffer, checks for rate limit pattern after each chunk.
   */
  function simulateBufferScan(chunks) {
    let outputBuffer = '';
    let rateLimitDetected = false;
    let resetTime = null;

    for (const chunk of chunks) {
      outputBuffer += chunk;
      if (outputBuffer.length > OUTPUT_BUFFER_MAX) {
        outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_TRIM);
      }

      if (rateLimitDetected) continue;

      const stripped = stripAnsi(outputBuffer);
      const match = RATE_LIMIT_PATTERN.exec(stripped);
      if (match) {
        rateLimitDetected = true;
        resetTime = match[1].trim();
      }
    }

    return { rateLimitDetected, resetTime };
  }

  it('detects rate limit when message arrives in a single chunk', () => {
    const result = simulateBufferScan([
      'Working on your task...\n',
      'Limit reached · resets in 2h 30m\n',
    ]);
    assert.equal(result.rateLimitDetected, true);
    assert.equal(result.resetTime, 'in 2h 30m');
  });

  it('detects rate limit when message is split across chunks', () => {
    const result = simulateBufferScan([
      'Working...\n',
      'Limit reached · ',
      'resets in 1h 15m\n',
    ]);
    assert.equal(result.rateLimitDetected, true);
    assert.equal(result.resetTime, 'in 1h 15m');
  });

  it('detects rate limit after buffer trimming', () => {
    // Fill the buffer close to the max, then add the rate limit message
    const filler = 'x'.repeat(3500);
    const result = simulateBufferScan([
      filler,
      '\nSome more output...\n',
      'Limit reached · resets Feb 16 at 5pm (US/Eastern)\n',
    ]);
    assert.equal(result.rateLimitDetected, true);
    assert.equal(result.resetTime, 'Feb 16 at 5pm (US/Eastern)');
  });

  it('does not detect rate limit in normal output', () => {
    const result = simulateBufferScan([
      'Starting task...\n',
      'Reading files...\n',
      'Writing code...\n',
      'Done!\n',
    ]);
    assert.equal(result.rateLimitDetected, false);
    assert.equal(result.resetTime, null);
  });

  it('handles rate limit message with ANSI codes in chunks', () => {
    const result = simulateBufferScan([
      '\x1b[32mWorking...\x1b[0m\n',
      '\x1b[1mLimit reached\x1b[0m \x1b[2m·\x1b[0m ',
      '\x1b[2mresets in 3h\x1b[0m\n',
    ]);
    assert.equal(result.rateLimitDetected, true);
    assert.equal(result.resetTime, 'in 3h');
  });

  it('detects rate limit even after many chunks of output', () => {
    const chunks = [];
    // Simulate 50 chunks of normal output
    for (let i = 0; i < 50; i++) {
      chunks.push(`Line ${i}: doing some work on the project...\n`);
    }
    // Then the rate limit
    chunks.push('Limit reached · resets in 4h 45m\n');

    const result = simulateBufferScan(chunks);
    assert.equal(result.rateLimitDetected, true);
    assert.equal(result.resetTime, 'in 4h 45m');
  });

  it('only captures the first rate limit match', () => {
    const result = simulateBufferScan([
      'Limit reached · resets in 1h\n',
      'Limit reached · resets in 2h\n',
    ]);
    assert.equal(result.rateLimitDetected, true);
    assert.equal(result.resetTime, 'in 1h');
  });
});

describe('findEarliestReset', () => {
  function makeAccount(name, sessionResetsAt, weeklyResetsAt) {
    return {
      name,
      usage: {
        sessionPercent: 99,
        weeklyPercent: 99,
        sessionResetsAt,
        weeklyResetsAt,
      },
    };
  }

  it('picks the earliest reset time across multiple accounts', () => {
    const now = Date.now();
    const accounts = [
      makeAccount('a', new Date(now + 3_600_000).toISOString(), new Date(now + 7_200_000).toISOString()),
      makeAccount('b', new Date(now + 1_800_000).toISOString(), new Date(now + 5_400_000).toISOString()),
    ];

    const result = findEarliestReset(accounts);
    // Should pick account b's sessionResetsAt (30min = 1_800_000ms)
    assert.ok(result > 0);
    assert.ok(result <= 1_800_000);
    assert.ok(result >= 1_790_000); // allow small timing delta
  });

  it('excludes the named account', () => {
    const now = Date.now();
    const accounts = [
      makeAccount('excluded', new Date(now + 600_000).toISOString(), null),   // earliest, but excluded
      makeAccount('included', new Date(now + 3_600_000).toISOString(), null), // 1h
    ];

    const result = findEarliestReset(accounts, 'excluded');
    assert.ok(result > 600_000, 'should not use excluded account reset time');
    assert.ok(result <= 3_600_000);
  });

  it('returns 0 when all accounts are missing reset timestamps', () => {
    const accounts = [
      makeAccount('a', null, null),
      makeAccount('b', null, null),
    ];

    const result = findEarliestReset(accounts);
    assert.equal(result, 0);
  });

  it('returns 0 when reset times are in the past', () => {
    const now = Date.now();
    const accounts = [
      makeAccount('a', new Date(now - 3_600_000).toISOString(), new Date(now - 1_800_000).toISOString()),
    ];

    const result = findEarliestReset(accounts);
    assert.equal(result, 0);
  });

  it('handles mix of valid and invalid reset timestamps', () => {
    const now = Date.now();
    const accounts = [
      makeAccount('a', 'not-a-date', null),
      makeAccount('b', null, new Date(now + 7_200_000).toISOString()),
    ];

    const result = findEarliestReset(accounts);
    assert.ok(result > 0);
    assert.ok(result <= 7_200_000);
  });

  it('prefers session reset over weekly if session is earlier', () => {
    const now = Date.now();
    const accounts = [
      makeAccount('a', new Date(now + 1_800_000).toISOString(), new Date(now + 86_400_000).toISOString()),
    ];

    const result = findEarliestReset(accounts);
    assert.ok(result <= 1_800_000);
  });

  it('handles accounts with null usage', () => {
    const now = Date.now();
    const accounts = [
      { name: 'null-usage', usage: null },
      makeAccount('ok', new Date(now + 3_600_000).toISOString(), null),
    ];

    const result = findEarliestReset(accounts);
    assert.ok(result > 0);
    assert.ok(result <= 3_600_000);
  });
});

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    assert.equal(formatDuration(2 * 3_600_000 + 15 * 60_000), '2h 15m');
  });

  it('formats minutes only when under 1 hour', () => {
    assert.equal(formatDuration(45 * 60_000), '45m');
  });

  it('formats zero minutes', () => {
    assert.equal(formatDuration(30_000), '0m');
  });

  it('formats exact hours', () => {
    assert.equal(formatDuration(3 * 3_600_000), '3h 0m');
  });
});

describe('sleep', () => {
  it('resolves after the given duration with interrupted: false', async () => {
    const start = Date.now();
    const { interrupted } = await sleep(50);
    const elapsed = Date.now() - start;
    assert.equal(interrupted, false);
    assert.ok(elapsed >= 40, `should have slept ~50ms, got ${elapsed}ms`);
  });

  it('resolves early with interrupted: true on SIGINT', async () => {
    const start = Date.now();
    // Schedule SIGINT after 30ms; sleep is 5 seconds
    const timer = setTimeout(() => process.emit('SIGINT'), 30);
    const { interrupted } = await sleep(5000);
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    assert.equal(interrupted, true);
    assert.ok(elapsed < 1000, `should have been interrupted quickly, got ${elapsed}ms`);
  });

  it('resolves early with interrupted: true on SIGTERM', async () => {
    const start = Date.now();
    const timer = setTimeout(() => process.emit('SIGTERM'), 30);
    const { interrupted } = await sleep(5000);
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    assert.equal(interrupted, true);
    assert.ok(elapsed < 1000, `should have been interrupted quickly, got ${elapsed}ms`);
  });

  it('cleans up signal listeners after normal completion', async () => {
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    await sleep(10);
    const after = process.listenerCount('SIGINT');
    const afterTerm = process.listenerCount('SIGTERM');
    assert.equal(after, before, 'should not leak SIGINT listeners');
    assert.equal(afterTerm, beforeTerm, 'should not leak SIGTERM listeners');
  });

  it('cleans up signal listeners after interruption', async () => {
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const timer = setTimeout(() => process.emit('SIGINT'), 10);
    await sleep(5000);
    clearTimeout(timer);
    const after = process.listenerCount('SIGINT');
    const afterTerm = process.listenerCount('SIGTERM');
    assert.equal(after, before, 'should not leak SIGINT listeners after interrupt');
    assert.equal(afterTerm, beforeTerm, 'should not leak SIGTERM listeners after interrupt');
  });
});

describe('effectiveUtilization', () => {

  it('returns max of session and weekly percent', () => {
    assert.equal(effectiveUtilization({ sessionPercent: 30, weeklyPercent: 70 }), 70);
    assert.equal(effectiveUtilization({ sessionPercent: 90, weeklyPercent: 50 }), 90);
  });

  it('returns 100 for null usage', () => {
    assert.equal(effectiveUtilization(null), 100);
  });

  it('returns 100 for undefined usage', () => {
    assert.equal(effectiveUtilization(undefined), 100);
  });

  it('handles zero values', () => {
    assert.equal(effectiveUtilization({ sessionPercent: 0, weeklyPercent: 0 }), 0);
  });

  it('handles missing percent fields', () => {
    assert.equal(effectiveUtilization({}), 0);
    assert.equal(effectiveUtilization({ sessionPercent: 50 }), 50);
    assert.equal(effectiveUtilization({ weeklyPercent: 80 }), 80);
  });

  it('returns exactly 99 at the threshold boundary', () => {
    assert.equal(effectiveUtilization({ sessionPercent: 99, weeklyPercent: 50 }), 99);
    assert.equal(effectiveUtilization({ sessionPercent: 50, weeklyPercent: 99 }), 99);
  });
});

describe('EXHAUSTION_THRESHOLD and MAX_SLEEP_MS constants', () => {
  it('EXHAUSTION_THRESHOLD is 99', () => {
    assert.equal(EXHAUSTION_THRESHOLD, 99);
  });

  it('MAX_SLEEP_MS is 6 hours', () => {
    assert.equal(MAX_SLEEP_MS, 6 * 60 * 60 * 1000);
  });

  it('MAX_SLEEP_MS clamp logic works correctly', () => {
    // Simulate the clamping logic from runner.js
    const clamp = (ms) => Math.min(ms, MAX_SLEEP_MS);

    // Under the cap
    assert.equal(clamp(3_600_000), 3_600_000); // 1h stays 1h
    // At the cap
    assert.equal(clamp(MAX_SLEEP_MS), MAX_SLEEP_MS); // 6h stays 6h
    // Over the cap
    assert.equal(clamp(12 * 60 * 60 * 1000), MAX_SLEEP_MS); // 12h clamped to 6h
    assert.equal(clamp(24 * 60 * 60 * 1000), MAX_SLEEP_MS); // 24h clamped to 6h
  });
});
