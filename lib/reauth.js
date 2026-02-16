/**
 * Shared re-authentication helpers.
 *
 * Uses `claude auth login` for non-interactive browser-based OAuth re-login
 * when tokens are expired or missing. Used by both `cmdReauth` and the
 * pre-flight check before launching Claude.
 */

import { spawn } from 'child_process';
import { readCredentials, isTokenExpired } from './keychain.js';

/**
 * Re-authenticate a single account via `claude auth login`.
 * Opens the browser for OAuth — no interactive Claude session needed.
 *
 * @param {{ name: string, configDir: string }} account
 * @returns {Promise<boolean>} true if credentials were refreshed successfully
 */
export async function reauthAccount(account) {
  console.error(`\n[claude-nonstop] Re-authenticating "${account.name}"...`);
  console.error(`  Config: ${account.configDir}`);
  console.error('  Opening browser for login...\n');

  // Strip CLAUDECODE so this works when called from inside a Claude Code session
  const authEnv = { ...process.env, CLAUDE_CONFIG_DIR: account.configDir };
  delete authEnv.CLAUDECODE;

  await new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'login'], {
      env: authEnv,
      stdio: 'inherit',
    });

    child.on('close', () => resolve());
    child.on('error', (err) => {
      console.error(`  Failed to launch Claude Code: ${err.message}`);
      resolve();
    });
  });

  const creds = readCredentials(account.configDir);
  if (creds.token && !isTokenExpired(creds)) {
    console.error(`  "${account.name}" authenticated successfully.`);
    if (creds.email) console.error(`  Email: ${creds.email}`);
    return true;
  }

  console.error(`  Warning: "${account.name}" still not authenticated.`);
  return false;
}

/**
 * Identify accounts needing re-auth and attempt to fix them interactively.
 *
 * Checks for:
 * - Missing tokens (no credentials in keychain)
 * - Expired tokens (expiresAt < now)
 * - API-rejected tokens (usage API returned HTTP 401)
 *
 * Skips re-auth if stdin is not a TTY (non-interactive mode).
 *
 * @param {Array<{name: string, configDir: string, token?: string, usage?: object}>} accounts
 *   Accounts enriched with token and/or usage data
 * @returns {Promise<string[]>} Names of accounts that were successfully re-authenticated
 */
export async function reauthExpiredAccounts(accounts) {
  if (!process.stdin.isTTY) {
    console.error('[claude-nonstop] Non-interactive mode — skipping re-auth. Run "claude-nonstop reauth" manually.');
    return [];
  }

  const needsReauth = accounts.filter(a => {
    // No token at all
    if (!a.token) return true;
    // Token expired per keychain expiresAt
    const creds = readCredentials(a.configDir);
    if (isTokenExpired(creds)) return true;
    // Usage API returned an auth error
    if (a.usage?.error === 'HTTP 401') return true;
    return false;
  });

  if (needsReauth.length === 0) return [];

  console.error(`\n[claude-nonstop] ${needsReauth.length} account(s) need re-authentication:`);
  for (const a of needsReauth) {
    const reason = !a.token ? 'no credentials'
      : a.usage?.error === 'HTTP 401' ? 'token rejected (401)'
      : 'token expired';
    console.error(`  ${a.name}: ${reason}`);
  }

  const refreshed = [];
  for (const account of needsReauth) {
    const success = await reauthAccount(account);
    if (success) refreshed.push(account.name);
  }

  return refreshed;
}
