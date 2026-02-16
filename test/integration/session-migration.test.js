import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { createTempDir, removeTempDir } from '../helpers/temp-dir.js';
import {
  getCwdHash,
  findLatestSession,
  migrateSession,
  findSessionAcrossProfiles,
} from '../../lib/session.js';

describe('session migration integration', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('create → find → migrate → verify full cycle', () => {
    const cwd = '/Users/test/code/myproject';
    const sessionId = 'test-session-001';
    const hash = getCwdHash(cwd);

    // Create source account with session
    const fromDir = join(tempDir, 'from-account');
    const projectDir = join(fromDir, 'projects', hash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{"type":"test","data":"original"}\n');

    // Create tool-results
    const toolResultsDir = join(projectDir, sessionId);
    mkdirSync(toolResultsDir, { recursive: true });
    writeFileSync(join(toolResultsDir, 'result-1.json'), '{"status":"ok"}');

    // Find session
    const found = findLatestSession(fromDir, cwd);
    assert.ok(found !== null);
    assert.equal(found.sessionId, sessionId);

    // Migrate to new account
    const toDir = join(tempDir, 'to-account');
    const result = migrateSession(fromDir, toDir, cwd, sessionId);
    assert.equal(result.success, true);

    // Verify files were copied
    const toProjectDir = join(toDir, 'projects', hash);
    assert.ok(existsSync(join(toProjectDir, `${sessionId}.jsonl`)));
    assert.ok(existsSync(join(toProjectDir, sessionId, 'result-1.json')));

    // Verify content is identical
    const original = readFileSync(join(projectDir, `${sessionId}.jsonl`), 'utf8');
    const copied = readFileSync(join(toProjectDir, `${sessionId}.jsonl`), 'utf8');
    assert.equal(original, copied);
  });

  it('find across multiple profiles picks newest', () => {
    const cwd = '/Users/test/project';
    const hash = getCwdHash(cwd);
    const sessionId = 'shared-session';

    // Account 1: old session
    const acct1Dir = join(tempDir, 'acct1');
    const proj1 = join(acct1Dir, 'projects', hash);
    mkdirSync(proj1, { recursive: true });
    const file1 = join(proj1, `${sessionId}.jsonl`);
    writeFileSync(file1, 'old data\n');
    const oldTime = new Date('2025-01-01');
    utimesSync(file1, oldTime, oldTime);

    // Account 2: new session
    const acct2Dir = join(tempDir, 'acct2');
    const proj2 = join(acct2Dir, 'projects', hash);
    mkdirSync(proj2, { recursive: true });
    writeFileSync(join(proj2, `${sessionId}.jsonl`), 'new data\n');

    const accounts = [
      { name: 'acct1', configDir: acct1Dir },
      { name: 'acct2', configDir: acct2Dir },
    ];

    const found = findSessionAcrossProfiles(accounts, sessionId);
    assert.ok(found !== null);
    assert.equal(found.account.name, 'acct2');
  });

  it('migration handles missing tool-results gracefully', () => {
    const cwd = '/Users/test/simple';
    const hash = getCwdHash(cwd);

    const fromDir = join(tempDir, 'from');
    const projectDir = join(fromDir, 'projects', hash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'simple-session.jsonl'), 'data\n');
    // No tool-results directory

    const toDir = join(tempDir, 'to');
    const result = migrateSession(fromDir, toDir, cwd, 'simple-session');
    assert.equal(result.success, true);

    // Session file copied, no tool-results dir in destination
    assert.ok(existsSync(join(toDir, 'projects', hash, 'simple-session.jsonl')));
  });
});
