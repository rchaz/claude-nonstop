import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

/**
 * Integration test: `claude-nonstop swap <target>` — argument parsing,
 * validation, and output shape.
 *
 * Spawns the bin script as a subprocess and asserts stderr / stdout. Does
 * not require real Anthropic credentials — validates the flag-parsing /
 * usage / not-found error paths only.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN = join(__dirname, '..', '..', 'bin', 'claude-nonstop.js');

function runSwap(args, env = {}) {
  return spawnSync('node', [BIN, 'swap', ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
}

describe('cmdSwap argument parsing', () => {
  it('exits 1 with usage when target missing', () => {
    const result = runSwap([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: claude-nonstop swap/);
    assert.match(result.stderr, /target-account/);
  });

  it('exits 1 with usage when first arg is a flag', () => {
    const result = runSwap(['--quiet']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: claude-nonstop swap/);
  });

  it('exits 1 when target account does not exist', () => {
    const result = runSwap(['definitely-not-a-real-account-xyz']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Account "definitely-not-a-real-account-xyz" not found/);
    assert.match(result.stderr, /Available accounts:/);
  });

  it('--quiet flag is accepted in any position', () => {
    // First arg --quiet is treated as missing target (flag, not name)
    const r1 = runSwap(['--quiet', 'somewhere']);
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /Usage:/);

    // Second arg --quiet is properly consumed (target may still error on cred lookup)
    const r2 = runSwap(['nonexistent-acct', '--quiet']);
    assert.equal(r2.status, 1);
    // --quiet was consumed, so we hit the not-found branch (error is on stderr)
    assert.match(r2.stderr, /not found/);
  });

  it('--session=<id> flag is accepted', () => {
    // Even with explicit session, nonexistent target still errors first
    const result = runSwap(['fake-acct', '--session=00000000-0000-0000-0000-000000000000']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not found/);
  });
});
