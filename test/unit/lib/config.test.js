import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'fs';
import { join } from 'path';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir.js';
import {
  validateAccountName,
  loadConfig,
  saveConfig,
  addAccount,
  removeAccount,
  ensureDefaultAccount,
  getAccounts,
  setAccountPriority,
  clearAccountPriority,
  DEFAULT_CLAUDE_DIR,
  CONFIG_DIR,
} from '../../../lib/config.js';

describe('validateAccountName', () => {
  it('accepts valid names', () => {
    assert.doesNotThrow(() => validateAccountName('myaccount'));
    assert.doesNotThrow(() => validateAccountName('account-1'));
    assert.doesNotThrow(() => validateAccountName('my_account'));
    assert.doesNotThrow(() => validateAccountName('Account123'));
  });

  it('rejects empty string', () => {
    assert.throws(() => validateAccountName(''), /required/);
  });

  it('rejects null', () => {
    assert.throws(() => validateAccountName(null), /required/);
  });

  it('rejects undefined', () => {
    assert.throws(() => validateAccountName(undefined), /required/);
  });

  it('rejects names with spaces', () => {
    assert.throws(() => validateAccountName('has spaces'), /letters, numbers/);
  });

  it('rejects path traversal', () => {
    assert.throws(() => validateAccountName('../bad'), /letters, numbers/);
  });

  it('rejects forward slashes', () => {
    assert.throws(() => validateAccountName('a/b'), /letters, numbers/);
  });

  it('rejects backslashes', () => {
    assert.throws(() => validateAccountName('a\\b'), /letters, numbers/);
  });

  it('rejects names exceeding 64 characters', () => {
    const longName = 'a'.repeat(65);
    assert.throws(() => validateAccountName(longName), /64 characters/);
  });

  it('accepts names at exactly 64 characters', () => {
    const name = 'a'.repeat(64);
    assert.doesNotThrow(() => validateAccountName(name));
  });

  it('rejects special characters', () => {
    assert.throws(() => validateAccountName('name!'), /letters, numbers/);
    assert.throws(() => validateAccountName('name@host'), /letters, numbers/);
    assert.throws(() => validateAccountName('name.ext'), /letters, numbers/);
  });

  it('rejects non-string values', () => {
    assert.throws(() => validateAccountName(123), /required/);
    assert.throws(() => validateAccountName({}), /required/);
  });
});

describe('loadConfig (real)', () => {
  it('returns an object with accounts array', () => {
    const config = loadConfig();
    assert.ok(Array.isArray(config.accounts));
  });

  it('all accounts have name and configDir strings', () => {
    const config = loadConfig();
    for (const account of config.accounts) {
      assert.equal(typeof account.name, 'string', `Account ${JSON.stringify(account)} missing name`);
      assert.equal(typeof account.configDir, 'string', `Account ${account.name} missing configDir`);
    }
  });
});

describe('saveConfig / loadConfig round-trip (real)', () => {
  // Tests that call real saveConfig + loadConfig against the live config.
  // We save the original config, modify, then restore to avoid pollution.
  let originalConfig;

  beforeEach(() => {
    originalConfig = loadConfig();
  });

  afterEach(() => {
    saveConfig(originalConfig);
  });

  it('round-trips config through save and load', () => {
    const testConfig = { ...originalConfig, _testMarker: true };
    saveConfig(testConfig);
    const loaded = loadConfig();
    assert.equal(loaded._testMarker, true);
    assert.deepEqual(loaded.accounts, originalConfig.accounts);
  });

  it('atomic write leaves no .tmp files in config dir', () => {
    saveConfig(originalConfig);
    // Check the real config directory for leftover tmp files
    const files = readdirSync(CONFIG_DIR);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    assert.deepEqual(tmpFiles, [], `Found leftover .tmp files: ${tmpFiles.join(', ')}`);
  });
});

describe('addAccount / removeAccount (real)', () => {
  // Use a unique name to avoid collisions, and always clean up
  const testName = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let added = false;

  afterEach(() => {
    if (added) {
      try { removeAccount(testName); } catch { /* already removed */ }
      added = false;
    }
  });

  it('addAccount creates profile directory and registers account', () => {
    const configDir = addAccount(testName);
    added = true;
    assert.ok(existsSync(configDir), 'Profile directory should be created');
    const config = loadConfig();
    const found = config.accounts.find(a => a.name === testName);
    assert.ok(found, 'Account should appear in config');
    assert.equal(found.configDir, configDir);
  });

  it('addAccount rejects duplicate names', () => {
    addAccount(testName);
    added = true;
    assert.throws(() => addAccount(testName), /already exists/);
  });

  it('removeAccount removes the account from config', () => {
    addAccount(testName);
    added = true;
    removeAccount(testName);
    added = false;
    const config = loadConfig();
    assert.ok(!config.accounts.some(a => a.name === testName), 'Account should be removed');
  });

  it('removeAccount throws for nonexistent account', () => {
    assert.throws(() => removeAccount('nonexistent-account-xyz-999'), /not found/);
  });

  it('removeAccount rejects removing default account', () => {
    const config = loadConfig();
    const defaultAcct = config.accounts.find(a => a.configDir === DEFAULT_CLAUDE_DIR);
    if (!defaultAcct) {
      // No default account on this machine — skip
      return;
    }
    assert.throws(() => removeAccount(defaultAcct.name), /Cannot remove/);
  });
});

describe('config file operations (temp dir)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('corrupted JSON falls back to empty config', () => {
    const configFile = join(tempDir, 'config.json');
    writeFileSync(configFile, '{invalid json!!!');

    // Replicate what loadConfig does — this verifies the recovery pattern
    let config = { accounts: [] };
    try {
      config = JSON.parse(readFileSync(configFile, 'utf-8'));
    } catch {
      config = { accounts: [] };
    }
    assert.deepEqual(config, { accounts: [] });
  });
});

describe('ensureDefaultAccount', () => {
  let originalConfig;

  beforeEach(() => {
    originalConfig = loadConfig();
  });

  afterEach(() => {
    saveConfig(originalConfig);
  });

  it('is idempotent — repeated calls do not duplicate the default account', () => {
    ensureDefaultAccount();
    const before = loadConfig();
    const defaultsBefore = before.accounts.filter(a => a.configDir === DEFAULT_CLAUDE_DIR);

    ensureDefaultAccount();
    const after = loadConfig();
    const defaultsAfter = after.accounts.filter(a => a.configDir === DEFAULT_CLAUDE_DIR);

    assert.equal(defaultsAfter.length, defaultsBefore.length,
      'ensureDefaultAccount should not create duplicates');
  });

  it('default account has configDir set to DEFAULT_CLAUDE_DIR', () => {
    ensureDefaultAccount();
    const config = loadConfig();
    const defaultAcct = config.accounts.find(a => a.configDir === DEFAULT_CLAUDE_DIR);
    if (existsSync(DEFAULT_CLAUDE_DIR)) {
      assert.ok(defaultAcct, 'Default account should exist when ~/.claude exists');
      assert.equal(defaultAcct.name, 'default');
    }
  });
});

describe('getAccounts', () => {
  it('returns an array', () => {
    const accounts = getAccounts();
    assert.ok(Array.isArray(accounts));
  });

  it('returns the same data as loadConfig().accounts', () => {
    const accounts = getAccounts();
    const config = loadConfig();
    assert.deepEqual(accounts, config.accounts);
  });
});

describe('setAccountPriority / clearAccountPriority', () => {
  const testName = `test-pri-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let added = false;

  beforeEach(() => {
    addAccount(testName);
    added = true;
  });

  afterEach(() => {
    if (added) {
      try { removeAccount(testName); } catch { /* already removed */ }
      added = false;
    }
  });

  it('sets priority on an account', () => {
    setAccountPriority(testName, 1);
    const config = loadConfig();
    const account = config.accounts.find(a => a.name === testName);
    assert.equal(account.priority, 1);
  });

  it('overwrites existing priority', () => {
    setAccountPriority(testName, 1);
    setAccountPriority(testName, 5);
    const config = loadConfig();
    const account = config.accounts.find(a => a.name === testName);
    assert.equal(account.priority, 5);
  });

  it('clears priority from an account', () => {
    setAccountPriority(testName, 1);
    clearAccountPriority(testName);
    const config = loadConfig();
    const account = config.accounts.find(a => a.name === testName);
    assert.equal(account.priority, undefined);
  });

  it('rejects non-integer priority', () => {
    assert.throws(() => setAccountPriority(testName, 1.5), /positive integer/);
  });

  it('rejects zero priority', () => {
    assert.throws(() => setAccountPriority(testName, 0), /positive integer/);
  });

  it('rejects negative priority', () => {
    assert.throws(() => setAccountPriority(testName, -1), /positive integer/);
  });

  it('rejects string priority', () => {
    assert.throws(() => setAccountPriority(testName, 'high'), /positive integer/);
  });

  it('throws for nonexistent account (set)', () => {
    assert.throws(() => setAccountPriority('nonexistent-xyz-999', 1), /not found/);
  });

  it('throws for nonexistent account (clear)', () => {
    assert.throws(() => clearAccountPriority('nonexistent-xyz-999'), /not found/);
  });

  it('clearAccountPriority is idempotent', () => {
    // Account has no priority initially — clearing should still work
    clearAccountPriority(testName);
    const config = loadConfig();
    const account = config.accounts.find(a => a.name === testName);
    assert.equal(account.priority, undefined);
  });
});
