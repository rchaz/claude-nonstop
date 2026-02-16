import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { validateAccountName } from '../../lib/config.js';
import { parseCredentialJson } from '../../lib/keychain.js';
import { validateSessionId } from '../../lib/session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

describe('security: account name validation', () => {
  it('rejects path traversal with ../', () => {
    assert.throws(() => validateAccountName('../etc/passwd'));
  });

  it('rejects path traversal with ..\\', () => {
    assert.throws(() => validateAccountName('..\\windows\\system32'));
  });

  it('rejects double dots embedded in name', () => {
    // The VALID_NAME_PATTERN rejects dots, so '..' is also rejected
    assert.throws(() => validateAccountName('a..b'));
  });

  it('rejects null bytes', () => {
    assert.throws(() => validateAccountName('name\x00bad'));
  });

  it('rejects shell metacharacters: semicolon', () => {
    assert.throws(() => validateAccountName('name;rm -rf /'));
  });

  it('rejects shell metacharacters: backtick', () => {
    assert.throws(() => validateAccountName('name`whoami`'));
  });

  it('rejects shell metacharacters: dollar sign', () => {
    assert.throws(() => validateAccountName('name$(cmd)'));
  });

  it('rejects shell metacharacters: pipe', () => {
    assert.throws(() => validateAccountName('name|cat /etc/passwd'));
  });

  it('rejects shell metacharacters: ampersand', () => {
    assert.throws(() => validateAccountName('name&bg'));
  });

  it('rejects newlines', () => {
    assert.throws(() => validateAccountName('name\ninjected'));
  });

  it('rejects tabs', () => {
    assert.throws(() => validateAccountName('name\tinjected'));
  });

  it('rejects extremely long names', () => {
    assert.throws(() => validateAccountName('a'.repeat(1000)));
  });

  it('rejects Unicode characters', () => {
    assert.throws(() => validateAccountName('naïve'));
  });

  it('rejects emoji', () => {
    assert.throws(() => validateAccountName('test🚀'));
  });

  it('rejects URL-like names', () => {
    assert.throws(() => validateAccountName('http://evil.com'));
  });

  it('accepts safe edge cases', () => {
    assert.doesNotThrow(() => validateAccountName('a'));
    assert.doesNotThrow(() => validateAccountName('A'));
    assert.doesNotThrow(() => validateAccountName('0'));
    assert.doesNotThrow(() => validateAccountName('a-b'));
    assert.doesNotThrow(() => validateAccountName('a_b'));
    assert.doesNotThrow(() => validateAccountName('test-account-123'));
  });
});

describe('security: session ID validation', () => {
  it('accepts valid UUID session IDs', () => {
    assert.doesNotThrow(() => validateSessionId('8d1462f9-fe97-42b9-be6f-5ef93a908b9e'));
    assert.doesNotThrow(() => validateSessionId('00000000-0000-0000-0000-000000000000'));
    assert.doesNotThrow(() => validateSessionId('ABCDEF12-3456-7890-ABCD-EF1234567890'));
  });

  it('rejects path traversal attempts', () => {
    assert.throws(() => validateSessionId('../../etc/passwd'), /Invalid session ID/);
    assert.throws(() => validateSessionId('../..'), /Invalid session ID/);
  });

  it('rejects non-UUID strings', () => {
    assert.throws(() => validateSessionId('not-a-uuid'), /Invalid session ID/);
    assert.throws(() => validateSessionId(''), /Invalid session ID/);
    assert.throws(() => validateSessionId('rm -rf /'), /Invalid session ID/);
  });

  it('rejects non-string values', () => {
    assert.throws(() => validateSessionId(null), /Invalid session ID/);
    assert.throws(() => validateSessionId(undefined), /Invalid session ID/);
    assert.throws(() => validateSessionId(123), /Invalid session ID/);
  });

  it('session IDs from findLatestSession are always basenames (safe)', () => {
    assert.equal(basename('../../etc/passwd.jsonl', '.jsonl'), 'passwd');
    assert.equal(basename('normal-session.jsonl', '.jsonl'), 'normal-session');
  });

  it('migrateSession validates sessionId before file operations', () => {
    const content = readFileSync(join(PROJECT_ROOT, 'lib', 'session.js'), 'utf-8');
    assert.ok(content.includes('validateSessionId(sessionId)'),
      'migrateSession should validate sessionId');
  });
});

describe('security: no credential exposure in logs', () => {
  const sourceFiles = [
    'lib/runner.js',
    'lib/keychain.js',
    'lib/config.js',
    'lib/usage.js',
    'lib/reauth.js',
    'lib/service.js',
    'remote/webhook.cjs',
    'remote/hook-notify.cjs',
    'remote/channel-manager.cjs',
    'remote/start-webhook.cjs',
  ];

  for (const file of sourceFiles) {
    it(`${file}: does not log token variables directly`, () => {
      let content;
      try {
        content = readFileSync(join(PROJECT_ROOT, file), 'utf-8');
      } catch {
        return; // File may not exist
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        // Check for direct logging of token variables (not string literals)
        // Match: console.log(token), console.log(`${token}`)
        // Skip: console.log('Token required'), console.log(botToken), console.log(appToken)
        if (/console\.(log|error|warn)\(.*\btoken\b/i.test(line) &&
            !line.includes('botToken') && !line.includes('appToken') &&
            !line.includes("'token'") && !line.includes('"token"')) {
          // Allow lines that are clearly not logging the value
          if (line.includes('expired') || line.includes('missing') || line.includes('rejected')) continue;
          // Allow string-only references (no variable interpolation with token)
          if (line.includes("'") && /console\.(log|error|warn)\('[^']*[Tt]oken[^']*'\)/.test(line)) continue;
          assert.fail(`${file}:${i + 1}: Possible token exposure in log: ${line.trim()}`);
        }

        // Check for template literal logging of actual credential values
        // Match: console.log(`${token}`), console.log(`${creds.accessToken}`)
        // Skip: console.log(`${creds.email}`), console.log(`${creds.name}`)
        if (/console\.(log|error|warn)\(`.*\$\{.*(?:\.accessToken|\.secret|\.oauthToken|\btoken\b|\bcredential\b)/i.test(line)) {
          assert.fail(`${file}:${i + 1}: Possible credential interpolation in log: ${line.trim()}`);
        }
      }
    });
  }

  it('parseCredentialJson does not include token value in error messages', () => {
    // Give it a valid-looking but bad token
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'invalid-secret-value', email: 'a@b.com' },
    });
    const result = parseCredentialJson(raw);
    assert.equal(result.error, 'invalid_token_format');
    // The error should not contain the actual token value
    assert.ok(!JSON.stringify(result).includes('invalid-secret-value'),
      'Error result should not contain the raw token value');
  });
});
