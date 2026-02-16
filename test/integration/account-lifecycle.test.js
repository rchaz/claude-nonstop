import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import {
  validateAccountName,
  loadConfig,
  addAccount,
  removeAccount,
  DEFAULT_CLAUDE_DIR,
} from '../../lib/config.js';

/**
 * Integration test: account lifecycle using real lib/config.js functions.
 * Creates uniquely-named test accounts and cleans them up after each test.
 */
describe('account lifecycle (real config.js)', () => {
  const createdAccounts = [];

  function addTestAccount(name) {
    const dir = addAccount(name);
    createdAccounts.push(name);
    return dir;
  }

  afterEach(() => {
    // Clean up all accounts created during the test
    while (createdAccounts.length > 0) {
      const name = createdAccounts.pop();
      try { removeAccount(name); } catch { /* already removed or doesn't exist */ }
    }
  });

  it('add → list → remove lifecycle', () => {
    const name1 = `test-lc1-${Date.now()}`;
    const name2 = `test-lc2-${Date.now()}`;

    const dir1 = addTestAccount(name1);
    const dir2 = addTestAccount(name2);

    assert.ok(existsSync(dir1), 'First profile directory should exist');
    assert.ok(existsSync(dir2), 'Second profile directory should exist');

    // Both appear in config
    const config = loadConfig();
    assert.ok(config.accounts.some(a => a.name === name1));
    assert.ok(config.accounts.some(a => a.name === name2));

    // Remove one
    removeAccount(name2);
    createdAccounts.pop(); // Already removed, don't double-remove in afterEach

    const after = loadConfig();
    assert.ok(after.accounts.some(a => a.name === name1), 'First should still exist');
    assert.ok(!after.accounts.some(a => a.name === name2), 'Second should be removed');
  });

  it('rejects duplicate account names', () => {
    const name = `test-dup-${Date.now()}`;
    addTestAccount(name);
    assert.throws(() => addAccount(name), /already exists/);
  });

  it('rejects removing nonexistent account', () => {
    assert.throws(() => removeAccount(`ghost-${Date.now()}`), /not found/);
  });

  it('prevents removing the default account', () => {
    const config = loadConfig();
    const defaultAcct = config.accounts.find(a => a.configDir === DEFAULT_CLAUDE_DIR);
    if (!defaultAcct) return; // No default on this machine
    assert.throws(() => removeAccount(defaultAcct.name), /Cannot remove/);
  });

  it('config survives add → remove → add cycle', () => {
    const name = `test-cycle-${Date.now()}`;

    addTestAccount(name);
    removeAccount(name);
    createdAccounts.pop(); // Removed

    // Should succeed since it was removed
    addTestAccount(name);
    const config = loadConfig();
    assert.ok(config.accounts.some(a => a.name === name));
  });

  it('validates account names through addAccount', () => {
    assert.throws(() => addAccount('../bad'), /letters, numbers/);
    assert.throws(() => addAccount(''), /required/);
    assert.throws(() => addAccount('has spaces'), /letters, numbers/);
  });
});
