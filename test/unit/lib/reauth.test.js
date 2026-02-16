import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

describe('reauthExpiredAccounts filtering logic', () => {
  // We test the filtering logic by verifying the source code patterns
  // rather than calling the function directly, since it requires
  // interactive TTY and spawns child processes.

  const content = readFileSync(join(PROJECT_ROOT, 'lib', 'reauth.js'), 'utf-8');

  it('checks for missing token (!a.token)', () => {
    assert.ok(content.includes('!a.token'),
      'Should filter accounts with no token');
  });

  it('checks for expired token via isTokenExpired', () => {
    assert.ok(content.includes('isTokenExpired(creds)'),
      'Should check token expiration via isTokenExpired');
  });

  it('checks for HTTP 401 usage error', () => {
    assert.ok(content.includes("a.usage?.error === 'HTTP 401'"),
      'Should detect HTTP 401 from usage API');
  });

  it('skips reauth in non-interactive mode', () => {
    assert.ok(content.includes('process.stdin.isTTY'),
      'Should check for TTY before attempting interactive reauth');
  });

  it('strips CLAUDECODE env var for child process', () => {
    assert.ok(content.includes('delete authEnv.CLAUDECODE'),
      'Should strip CLAUDECODE so nested auth works');
  });

  it('uses spawn with array args (not exec)', () => {
    assert.ok(content.includes("spawn('claude', ['auth', 'login']"),
      'Should use spawn with array args');
  });
});

describe('reauthExpiredAccounts returns empty for non-TTY', () => {
  let originalIsTTY;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it('returns empty array when not a TTY', async () => {
    process.stdin.isTTY = false;
    const { reauthExpiredAccounts } = await import('../../../lib/reauth.js');
    const result = await reauthExpiredAccounts([
      { name: 'test', configDir: '/tmp/nonexistent' },
    ]);
    assert.deepEqual(result, []);
  });
});
