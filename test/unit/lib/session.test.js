import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir.js';
import {
  getCwdHash,
  getProjectDir,
  findLatestSession,
  migrateSession,
  findSessionAcrossProfiles,
  findLatestSessionAcrossProfiles,
  migrateSessionByHash,
  validateSessionId,
} from '../../../lib/session.js';

// Valid UUIDs for tests
const UUID1 = '11111111-1111-1111-1111-111111111111';
const UUID2 = '22222222-2222-2222-2222-222222222222';
const UUID3 = '33333333-3333-3333-3333-333333333333';

describe('validateSessionId', () => {
  it('accepts valid UUID v4', () => {
    assert.doesNotThrow(() => validateSessionId('8d1462f9-fe97-42b9-be6f-5ef93a908b9e'));
  });

  it('accepts uppercase UUIDs', () => {
    assert.doesNotThrow(() => validateSessionId('8D1462F9-FE97-42B9-BE6F-5EF93A908B9E'));
  });

  it('accepts all-zeros UUID', () => {
    assert.doesNotThrow(() => validateSessionId('00000000-0000-0000-0000-000000000000'));
  });

  it('rejects path traversal', () => {
    assert.throws(() => validateSessionId('../../etc/passwd'), /Invalid session ID/);
  });

  it('rejects non-UUID strings', () => {
    assert.throws(() => validateSessionId('not-a-uuid'), /Invalid session ID/);
    assert.throws(() => validateSessionId('sess-1'), /Invalid session ID/);
  });

  it('rejects empty string', () => {
    assert.throws(() => validateSessionId(''), /Invalid session ID/);
  });

  it('rejects null/undefined', () => {
    assert.throws(() => validateSessionId(null), /Invalid session ID/);
    assert.throws(() => validateSessionId(undefined), /Invalid session ID/);
  });

  it('rejects non-string types', () => {
    assert.throws(() => validateSessionId(123), /Invalid session ID/);
    assert.throws(() => validateSessionId({}), /Invalid session ID/);
  });

  it('rejects UUID with extra characters', () => {
    assert.throws(() => validateSessionId('8d1462f9-fe97-42b9-be6f-5ef93a908b9e-extra'), /Invalid session ID/);
  });
});

describe('getCwdHash', () => {
  it('replaces path separators with hyphens', () => {
    assert.equal(getCwdHash('/Users/rc/code/myproject'), '-Users-rc-code-myproject');
  });

  it('expands ~ to homedir', () => {
    const result = getCwdHash('~/code/project');
    assert.ok(result.startsWith('-'));
    assert.ok(!result.includes('~'));
    const expected = `${homedir()}/code/project`.replace(/\//g, '-');
    assert.equal(result, expected);
  });

  it('handles root path', () => {
    assert.equal(getCwdHash('/'), '-');
  });
});

describe('getProjectDir', () => {
  it('combines configDir + projects/ + hash', () => {
    const result = getProjectDir('/home/user/.claude', '/tmp/myproject');
    assert.equal(result, join('/home/user/.claude', 'projects', '-tmp-myproject'));
  });

  it('expands ~ in configDir', () => {
    const result = getProjectDir('~/.claude', '/tmp/test');
    assert.ok(result.startsWith(homedir()));
    assert.ok(result.includes('projects'));
  });
});

describe('findLatestSession', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('picks the newest .jsonl by mtime', () => {
    const cwd = '/tmp/testproject';
    const hash = getCwdHash(cwd);
    const projectDir = join(tempDir, 'projects', hash);
    mkdirSync(projectDir, { recursive: true });

    // Create two session files with different mtimes
    const oldFile = join(projectDir, 'old-session.jsonl');
    const newFile = join(projectDir, 'new-session.jsonl');
    writeFileSync(oldFile, '{"type":"test"}\n');
    writeFileSync(newFile, '{"type":"test"}\n');

    // Set old file to an older time
    const oldTime = new Date('2025-01-01');
    utimesSync(oldFile, oldTime, oldTime);

    const result = findLatestSession(tempDir, cwd);
    assert.equal(result.sessionId, 'new-session');
  });

  it('returns null for empty directory', () => {
    const cwd = '/tmp/empty';
    const hash = getCwdHash(cwd);
    const projectDir = join(tempDir, 'projects', hash);
    mkdirSync(projectDir, { recursive: true });

    assert.equal(findLatestSession(tempDir, cwd), null);
  });

  it('returns null for missing directory', () => {
    assert.equal(findLatestSession(tempDir, '/nonexistent'), null);
  });

  it('ignores non-.jsonl files', () => {
    const cwd = '/tmp/mixed';
    const hash = getCwdHash(cwd);
    const projectDir = join(tempDir, 'projects', hash);
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(projectDir, 'readme.txt'), 'not a session');
    writeFileSync(join(projectDir, 'real-session.jsonl'), '{"type":"test"}\n');

    const result = findLatestSession(tempDir, cwd);
    assert.equal(result.sessionId, 'real-session');
  });
});

describe('migrateSession', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('copies .jsonl file to destination', () => {
    const fromDir = join(tempDir, 'from');
    const toDir = join(tempDir, 'to');
    const cwd = '/tmp/project';
    const hash = getCwdHash(cwd);

    const fromProjectDir = join(fromDir, 'projects', hash);
    mkdirSync(fromProjectDir, { recursive: true });
    writeFileSync(join(fromProjectDir, `${UUID1}.jsonl`), 'test data\n');

    const result = migrateSession(fromDir, toDir, cwd, UUID1);
    assert.equal(result.success, true);

    assert.ok(existsSync(join(toDir, 'projects', hash, `${UUID1}.jsonl`)));
  });

  it('copies tool-results directory', () => {
    const fromDir = join(tempDir, 'from');
    const toDir = join(tempDir, 'to');
    const cwd = '/tmp/project';
    const hash = getCwdHash(cwd);

    const fromProjectDir = join(fromDir, 'projects', hash);
    mkdirSync(fromProjectDir, { recursive: true });
    writeFileSync(join(fromProjectDir, `${UUID2}.jsonl`), 'test data\n');

    const toolResultsDir = join(fromProjectDir, UUID2);
    mkdirSync(toolResultsDir, { recursive: true });
    writeFileSync(join(toolResultsDir, 'result.json'), '{"ok":true}');

    const result = migrateSession(fromDir, toDir, cwd, UUID2);
    assert.equal(result.success, true);

    assert.ok(existsSync(join(toDir, 'projects', hash, UUID2, 'result.json')));
  });

  it('returns error for missing source session', () => {
    const fromDir = join(tempDir, 'from');
    const toDir = join(tempDir, 'to');
    mkdirSync(join(fromDir, 'projects', '-tmp'), { recursive: true });

    const result = migrateSession(fromDir, toDir, '/tmp', UUID3);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('not found'));
  });

  it('rejects path traversal in session ID', () => {
    const fromDir = join(tempDir, 'from');
    const toDir = join(tempDir, 'to');
    assert.throws(() => migrateSession(fromDir, toDir, '/tmp', '../../etc/passwd'), /Invalid session ID/);
  });
});

describe('findSessionAcrossProfiles', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('finds a session across multiple accounts', () => {
    const account1Dir = join(tempDir, 'acct1');
    const account2Dir = join(tempDir, 'acct2');
    const hash = '-tmp-project';

    mkdirSync(join(account2Dir, 'projects', hash), { recursive: true });
    writeFileSync(join(account2Dir, 'projects', hash, `${UUID1}.jsonl`), 'data');

    const accounts = [
      { name: 'acct1', configDir: account1Dir },
      { name: 'acct2', configDir: account2Dir },
    ];

    const result = findSessionAcrossProfiles(accounts, UUID1);
    assert.ok(result !== null);
    assert.equal(result.account.name, 'acct2');
    assert.equal(result.cwdHash, hash);
    assert.ok(result.path.endsWith(`${UUID1}.jsonl`));
    assert.ok(typeof result.mtime === 'number');
    assert.ok(result.mtime > 0);
  });

  it('picks the newest when session exists in multiple accounts', () => {
    const account1Dir = join(tempDir, 'acct1');
    const account2Dir = join(tempDir, 'acct2');
    const hash = '-tmp-project';

    mkdirSync(join(account1Dir, 'projects', hash), { recursive: true });
    mkdirSync(join(account2Dir, 'projects', hash), { recursive: true });

    const oldPath = join(account1Dir, 'projects', hash, `${UUID1}.jsonl`);
    const newPath = join(account2Dir, 'projects', hash, `${UUID1}.jsonl`);
    writeFileSync(oldPath, 'old');
    writeFileSync(newPath, 'new');
    utimesSync(oldPath, new Date('2025-01-01'), new Date('2025-01-01'));

    const accounts = [
      { name: 'acct1', configDir: account1Dir },
      { name: 'acct2', configDir: account2Dir },
    ];

    const result = findSessionAcrossProfiles(accounts, UUID1);
    assert.equal(result.account.name, 'acct2');
    assert.ok(result.path.includes('acct2'));
    assert.ok(result.mtime > new Date('2025-01-01').getTime());
  });

  it('returns null when session not found', () => {
    const accounts = [
      { name: 'acct1', configDir: join(tempDir, 'nodir') },
    ];
    assert.equal(findSessionAcrossProfiles(accounts, UUID1), null);
  });

  it('rejects path traversal in session ID', () => {
    const accounts = [{ name: 'acct1', configDir: join(tempDir, 'a') }];
    assert.throws(() => findSessionAcrossProfiles(accounts, '../../etc/passwd'), /Invalid session ID/);
  });
});

describe('findLatestSessionAcrossProfiles', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('finds the newest session across all accounts for the current project', () => {
    const acctDir = join(tempDir, 'acct');
    const hash = '-tmp-project';
    mkdirSync(join(acctDir, 'projects', hash), { recursive: true });
    writeFileSync(join(acctDir, 'projects', hash, 'latest.jsonl'), 'data');

    const accounts = [{ name: 'acct', configDir: acctDir }];
    const result = findLatestSessionAcrossProfiles(accounts, '/tmp/project');
    assert.ok(result !== null);
    assert.equal(result.sessionId, 'latest');
    assert.equal(result.account.name, 'acct');
    assert.equal(result.cwdHash, hash);
    assert.ok(result.path.endsWith('latest.jsonl'));
    assert.ok(typeof result.mtime === 'number');
    assert.ok(result.mtime > 0);
  });

  it('returns null for accounts with no sessions', () => {
    const accounts = [{ name: 'empty', configDir: join(tempDir, 'empty') }];
    assert.equal(findLatestSessionAcrossProfiles(accounts, '/tmp/nonexistent'), null);
  });
});

describe('migrateSessionByHash', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('migrates using cwdHash directly', () => {
    const fromDir = join(tempDir, 'from');
    const toDir = join(tempDir, 'to');
    const hash = '-tmp-project';

    mkdirSync(join(fromDir, 'projects', hash), { recursive: true });
    writeFileSync(join(fromDir, 'projects', hash, `${UUID1}.jsonl`), 'data');

    const result = migrateSessionByHash(fromDir, toDir, hash, UUID1);
    assert.equal(result.success, true);

    assert.ok(existsSync(join(toDir, 'projects', hash, `${UUID1}.jsonl`)));
  });

  it('returns error for missing source', () => {
    const fromDir = join(tempDir, 'from');
    const toDir = join(tempDir, 'to');
    mkdirSync(join(fromDir, 'projects', '-x'), { recursive: true });

    const result = migrateSessionByHash(fromDir, toDir, '-x', UUID1);
    assert.equal(result.success, false);
  });

  it('rejects path traversal in session ID', () => {
    const fromDir = join(tempDir, 'from');
    const toDir = join(tempDir, 'to');
    assert.throws(() => migrateSessionByHash(fromDir, toDir, '-x', '../../../etc'), /Invalid session ID/);
  });
});
