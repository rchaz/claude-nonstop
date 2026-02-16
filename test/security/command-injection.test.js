import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

/**
 * Security: verify that all subprocess calls use execFile/execFileSync/spawnSync
 * (array args) and NOT exec/execSync (string interpolation).
 */
describe('security: no exec/execSync with string interpolation', () => {
  const sourceFiles = [
    'lib/runner.js',
    'lib/keychain.js',
    'lib/service.js',
    'lib/tmux.js',
    'lib/config.js',
    'lib/session.js',
    'lib/reauth.js',
    'remote/webhook.cjs',
    'remote/hook-notify.cjs',
    'remote/channel-manager.cjs',
    'bin/claude-nonstop.js',
  ];

  // Verify the source file list stays in sync with the actual codebase
  it('sourceFiles list covers all lib/, remote/, and bin/ files', () => {
    const libFiles = readdirSync(join(PROJECT_ROOT, 'lib'))
      .filter(f => f.endsWith('.js'))
      .map(f => `lib/${f}`);
    const remoteFiles = readdirSync(join(PROJECT_ROOT, 'remote'))
      .filter(f => f.endsWith('.cjs'))
      .map(f => `remote/${f}`);
    const binFiles = readdirSync(join(PROJECT_ROOT, 'bin'))
      .filter(f => f.endsWith('.js'))
      .map(f => `bin/${f}`);

    const allFiles = [...libFiles, ...remoteFiles, ...binFiles];
    const missing = allFiles.filter(f => !sourceFiles.includes(f));
    // Exclude entry-point scripts that don't do subprocess calls
    // Exclude files that have no subprocess calls (pure logic modules)
    const excluded = [
      'remote/start-webhook.cjs', 'remote/load-env.cjs', 'remote/paths.cjs',
      'lib/platform.js', 'lib/scorer.js', 'lib/usage.js',
    ];
    const reallyMissing = missing.filter(f => !excluded.includes(f));

    assert.deepEqual(reallyMissing, [],
      `Source files not covered by security scan: ${reallyMissing.join(', ')}`);
  });

  for (const file of sourceFiles) {
    it(`${file}: does not use exec() or execSync() with string args`, () => {
      const filePath = join(PROJECT_ROOT, file);
      assert.ok(existsSync(filePath), `Source file ${file} not found — update the sourceFiles list`);

      const content = readFileSync(filePath, 'utf-8');

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip import/require lines
        if (line.includes('import') || line.includes('require')) continue;
        // Skip comments
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        // Check for dangerous exec() calls — must not be preceded by . (regex .exec) or word char
        // Use a separate check that the line does NOT contain execFile to avoid false negatives:
        // only skip if the exec( is actually part of an execFile( call on the same token
        const execMatch = /(?<!\.)(?<!\w)\bexec\s*\(/.exec(line);
        if (execMatch) {
          // Verify this isn't an execFile call by checking context around the match
          const before = line.substring(Math.max(0, execMatch.index - 4), execMatch.index);
          if (!before.endsWith('File')) {
            assert.fail(`${file}:${i + 1}: Found potentially dangerous exec() call: ${line.trim()}`);
          }
        }

        const execSyncMatch = /(?<!\.)(?<!\w)\bexecSync\s*\(/.exec(line);
        if (execSyncMatch) {
          const before = line.substring(Math.max(0, execSyncMatch.index - 8), execSyncMatch.index);
          if (!before.endsWith('File')) {
            assert.fail(`${file}:${i + 1}: Found potentially dangerous execSync() call: ${line.trim()}`);
          }
        }
      }
    });
  }
});

describe('security: tmux uses -l flag for literal mode', () => {
  it('webhook.cjs send-keys with user text always uses -l flag', () => {
    const content = readFileSync(join(PROJECT_ROOT, 'remote', 'webhook.cjs'), 'utf-8');
    const lines = content.split('\n');

    // Find all send-keys calls and verify -l is used for user text (not for control keys like C-c)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('send-keys') && !line.trim().startsWith('//')) {
        // Lines with C-c are control sequences — -l should NOT be used
        if (line.includes("'C-c'") || line.includes("'Enter'")) continue;
        // Lines sending user text (safeCommand variable) must use -l
        if (line.includes('safeCommand')) {
          assert.ok(line.includes("'-l'"),
            `Line ${i + 1}: send-keys with user text must use -l flag: ${line.trim()}`);
        }
      }
    }
  });
});

describe('security: tmux message truncation', () => {
  it('webhook.cjs truncates at MAX_TMUX_MESSAGE_LENGTH = 4096', () => {
    const content = readFileSync(join(PROJECT_ROOT, 'remote', 'webhook.cjs'), 'utf-8');
    assert.ok(content.includes('MAX_TMUX_MESSAGE_LENGTH'), 'Should define MAX_TMUX_MESSAGE_LENGTH');
    // Verify the constant value
    assert.match(content, /MAX_TMUX_MESSAGE_LENGTH\s*=\s*4096/,
      'MAX_TMUX_MESSAGE_LENGTH should be assigned 4096');
  });
});

describe('security: subprocess calls use array arguments', () => {
  it('keychain.js uses execFileSync with array args', () => {
    const content = readFileSync(join(PROJECT_ROOT, 'lib', 'keychain.js'), 'utf-8');
    const calls = content.match(/execFileSync\(/g);
    assert.ok(calls && calls.length > 0, 'keychain.js should have execFileSync calls');
    assert.ok(!content.includes('execFileSync(`'), 'Should not use template literals with execFileSync');
  });

  it('service.js uses execFileSync with array args', () => {
    const content = readFileSync(join(PROJECT_ROOT, 'lib', 'service.js'), 'utf-8');
    assert.ok(!content.includes('execFileSync(`'), 'Should not use template literals with execFileSync');
  });

  it('webhook.cjs uses spawnSync with array args', () => {
    const content = readFileSync(join(PROJECT_ROOT, 'remote', 'webhook.cjs'), 'utf-8');
    assert.ok(content.includes('spawnSync'));
    assert.ok(!content.includes('spawnSync(`'), 'Should not use template literals with spawnSync');
  });

  it('reauth.js uses spawn with array args (not string)', () => {
    const content = readFileSync(join(PROJECT_ROOT, 'lib', 'reauth.js'), 'utf-8');
    assert.ok(content.includes('spawn('));
    assert.ok(!content.includes('spawn(`'), 'Should not use template literals with spawn');
  });
});
