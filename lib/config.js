import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join, normalize } from 'path';

const CONFIG_DIR = join(homedir(), '.claude-nonstop');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PROFILES_DIR = join(CONFIG_DIR, 'profiles');
const DEFAULT_CLAUDE_DIR = normalize(join(homedir(), '.claude'));

/**
 * Ensure the config directory and profiles directory exist.
 */
export function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });
}

/**
 * Load config from disk. Returns { accounts: [{name, configDir}] }.
 * Pure read — does not write to disk.
 */
export function loadConfig() {
  ensureConfigDir();

  let config = { accounts: [] };

  if (existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      config = { accounts: [] };
    }
  }

  return config;
}

/**
 * Ensure the default ~/.claude account is registered if it exists on disk.
 * Call once at CLI startup, not on every read.
 */
export function ensureDefaultAccount() {
  const config = loadConfig();
  const hasDefault = config.accounts.some(a => a.configDir === DEFAULT_CLAUDE_DIR);
  if (!hasDefault && existsSync(DEFAULT_CLAUDE_DIR)) {
    config.accounts.unshift({ name: 'default', configDir: DEFAULT_CLAUDE_DIR });
    saveConfig(config);
  }
}

/**
 * Save config to disk using atomic write (write-to-temp + rename).
 */
export function saveConfig(config) {
  ensureConfigDir();
  const tmpFile = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpFile, CONFIG_FILE);
}

const VALID_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 64;

/**
 * Validate an account name for safety.
 * Allows letters, numbers, hyphens, and underscores only.
 */
export function validateAccountName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Account name is required');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Account name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  if (!VALID_NAME_PATTERN.test(name)) {
    throw new Error('Account name may only contain letters, numbers, hyphens, and underscores');
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error('Account name contains invalid characters');
  }
}

/**
 * Add a new account. Returns the configDir for the new profile.
 */
export function addAccount(name) {
  validateAccountName(name);
  const config = loadConfig();

  if (config.accounts.some(a => a.name === name)) {
    throw new Error(`Account "${name}" already exists`);
  }

  const configDir = join(PROFILES_DIR, name);
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  config.accounts.push({ name, configDir });
  saveConfig(config);

  return configDir;
}

/**
 * Remove an account by name.
 */
export function removeAccount(name) {
  const config = loadConfig();
  const idx = config.accounts.findIndex(a => a.name === name);

  if (idx === -1) throw new Error(`Account "${name}" not found`);
  if (config.accounts[idx].configDir === DEFAULT_CLAUDE_DIR) {
    throw new Error('Cannot remove the default account');
  }

  config.accounts.splice(idx, 1);
  saveConfig(config);
}

/**
 * Set priority for an account. Lower number = higher priority.
 *
 * @param {string} name - Account name
 * @param {number} priority - Positive integer (1 = highest priority)
 */
export function setAccountPriority(name, priority) {
  if (!Number.isInteger(priority) || priority < 1) {
    throw new Error('Priority must be a positive integer (1 = highest)');
  }

  const config = loadConfig();
  const account = config.accounts.find(a => a.name === name);

  if (!account) throw new Error(`Account "${name}" not found`);

  account.priority = priority;
  saveConfig(config);
}

/**
 * Remove priority from an account (reverts to unranked).
 *
 * @param {string} name - Account name
 */
export function clearAccountPriority(name) {
  const config = loadConfig();
  const account = config.accounts.find(a => a.name === name);

  if (!account) throw new Error(`Account "${name}" not found`);

  delete account.priority;
  saveConfig(config);
}

/**
 * Get all registered accounts.
 */
export function getAccounts() {
  return loadConfig().accounts;
}

export { CONFIG_DIR, PROFILES_DIR, DEFAULT_CLAUDE_DIR };
