import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'os';
import { normalize, join } from 'path';
import {
  calculateConfigDirHash,
  expandPath,
  getServiceName,
  isTokenExpired,
  parseCredentialJson,
  readCredentials,
} from '../../../lib/keychain.js';

describe('calculateConfigDirHash', () => {
  it('returns an 8-char hex string', () => {
    const hash = calculateConfigDirHash('/home/user/.claude');
    assert.match(hash, /^[a-f0-9]{8}$/);
  });

  it('is deterministic', () => {
    const hash1 = calculateConfigDirHash('/tmp/test');
    const hash2 = calculateConfigDirHash('/tmp/test');
    assert.equal(hash1, hash2);
  });

  it('different paths produce different hashes', () => {
    const hash1 = calculateConfigDirHash('/path/a');
    const hash2 = calculateConfigDirHash('/path/b');
    assert.notEqual(hash1, hash2);
  });
});

describe('expandPath', () => {
  it('expands ~ to homedir', () => {
    const result = expandPath('~/test');
    assert.ok(result.startsWith(homedir()));
    assert.ok(!result.includes('~'));
  });

  it('normalizes the path', () => {
    const result = expandPath('/a/b/../c');
    assert.equal(result, normalize('/a/c'));
  });

  it('leaves absolute paths unchanged (except normalization)', () => {
    const result = expandPath('/usr/local/bin');
    assert.equal(result, '/usr/local/bin');
  });
});

describe('getServiceName', () => {
  it('returns "Claude Code-credentials" for default dir', () => {
    const defaultDir = normalize(join(homedir(), '.claude'));
    const name = getServiceName(defaultDir);
    assert.equal(name, 'Claude Code-credentials');
  });

  it('returns "Claude Code-credentials" for ~ version of default dir', () => {
    const name = getServiceName('~/.claude');
    assert.equal(name, 'Claude Code-credentials');
  });

  it('includes hash for custom directories', () => {
    const name = getServiceName('/tmp/custom-claude-dir');
    assert.match(name, /^Claude Code-credentials-[a-f0-9]{8}$/);
  });

  it('different custom dirs get different names', () => {
    const name1 = getServiceName('/tmp/dir1');
    const name2 = getServiceName('/tmp/dir2');
    assert.notEqual(name1, name2);
  });
});

describe('isTokenExpired', () => {
  it('returns true for past expiration', () => {
    assert.equal(isTokenExpired({ expiresAt: 1000 }), true);
  });

  it('returns false for future expiration', () => {
    assert.equal(isTokenExpired({ expiresAt: Date.now() + 3600000 }), false);
  });

  it('returns false when expiresAt is null', () => {
    assert.equal(isTokenExpired({ expiresAt: null }), false);
  });

  it('returns false when expiresAt is undefined', () => {
    assert.equal(isTokenExpired({}), false);
  });

  it('returns false when expiresAt is 0', () => {
    assert.equal(isTokenExpired({ expiresAt: 0 }), false);
  });
});

describe('parseCredentialJson', () => {
  it('extracts token and email from valid JSON', () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-valid-token',
        email: 'user@example.com',
        expiresAt: 9999999999999,
      },
    });
    const result = parseCredentialJson(raw);
    assert.equal(result.token, 'sk-ant-oat01-valid-token');
    assert.equal(result.email, 'user@example.com');
    assert.equal(result.error, null);
  });

  it('returns error for missing oauth key', () => {
    const raw = JSON.stringify({ someOtherKey: {} });
    const result = parseCredentialJson(raw);
    assert.equal(result.token, null);
    assert.equal(result.error, 'no_oauth_data');
  });

  it('returns error for invalid token format', () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'invalid-token-format',
        email: 'user@example.com',
      },
    });
    const result = parseCredentialJson(raw);
    assert.equal(result.token, null);
    assert.equal(result.error, 'invalid_token_format');
    assert.equal(result.email, 'user@example.com');
  });

  it('returns error for malformed JSON', () => {
    const result = parseCredentialJson('not json at all');
    assert.equal(result.token, null);
    assert.equal(result.error, 'parse_failed');
  });

  it('handles missing accessToken', () => {
    const raw = JSON.stringify({
      claudeAiOauth: { email: 'user@example.com' },
    });
    const result = parseCredentialJson(raw);
    assert.equal(result.token, null);
    assert.equal(result.email, 'user@example.com');
  });

  it('extracts name from oauth object', () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-valid',
        name: 'Test User',
      },
    });
    const result = parseCredentialJson(raw);
    assert.equal(result.name, 'Test User');
  });

  it('handles expiresAt field', () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-valid',
        expiresAt: 1234567890000,
      },
    });
    const result = parseCredentialJson(raw);
    assert.equal(result.expiresAt, 1234567890000);
  });

  it('handles empty JSON object', () => {
    const result = parseCredentialJson('{}');
    assert.equal(result.token, null);
    assert.equal(result.error, 'no_oauth_data');
  });
});

describe('readCredentials', () => {
  it('returns an error for a nonexistent config dir', () => {
    const result = readCredentials('/nonexistent/surely-does-not-exist-xyz');
    // Should always fail gracefully with an error string
    assert.equal(result.token, null);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, 'error should be non-empty');
  });

  it('returns the full credential shape', () => {
    const result = readCredentials('/nonexistent/dir');
    assert.ok('token' in result);
    assert.ok('email' in result);
    assert.ok('name' in result);
    assert.ok('expiresAt' in result);
    assert.ok('error' in result);
  });
});
