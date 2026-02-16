import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_LIMIT_PATTERN, stripAnsi } from '../../../lib/runner.js';

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
