#!/usr/bin/env node

/**
 * claude-nonstop — Multi-account switching + Slack remote access for Claude Code.
 *
 * Run `claude-nonstop help` for usage.
 */

import { spawn, execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addAccount, removeAccount, getAccounts, ensureDefaultAccount, validateAccountName, setAccountPriority, clearAccountPriority, CONFIG_DIR, DEFAULT_CLAUDE_DIR } from '../lib/config.js';
import { readCredentials, isTokenExpired, deleteKeychainEntry } from '../lib/keychain.js';
import { checkAllUsage, checkUsage, fetchProfile } from '../lib/usage.js';
import { pickBestAccount, pickByPriority } from '../lib/scorer.js';
import { run } from '../lib/runner.js';
import { reauthAccount, reauthExpiredAccounts, silentRefresh } from '../lib/reauth.js';
import { isMacOS } from '../lib/platform.js';
import { installService, uninstallService, restartService, getServiceStatus, isServiceInstalled, LOG_PATH } from '../lib/service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0];

// Auto-detect default account once at startup
ensureDefaultAccount();

switch (command) {
  case 'add':
    await cmdAdd(args.slice(1));
    break;

  case 'remove':
    await cmdRemove(args.slice(1));
    break;

  case 'list':
    await cmdList();
    break;

  case 'status':
    await cmdStatus();
    break;

  case 'setup':
    await cmdSetup(args.slice(1));
    break;

  case 'webhook':
    await cmdWebhook(args.slice(1));
    break;

  case 'hooks':
    await cmdHooks(args.slice(1));
    break;

  case 'uninstall':
    await cmdUninstall(args.slice(1));
    break;

  case 'reauth':
    await cmdReauth();
    break;

  case 'update':
    await cmdUpdate();
    break;

  case 'resume':
    await cmdResume(args.slice(1));
    break;

  case 'use':
    await cmdUse(args.slice(1));
    break;

  case 'set-priority':
    await cmdSetPriority(args.slice(1));
    break;

  case 'init':
    cmdInit(args[1]);
    break;

  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;

  case undefined:
    // No command given — default to running Claude
    await cmdRun([]);
    break;

  default:
    // Unknown command — treat as args to run (e.g. `claude-nonstop -p "fix bug"`)
    await cmdRun(args);
    break;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdAdd(args) {
  const name = args[0];
  if (!name) {
    console.error('Usage: claude-nonstop add <name>');
    console.error('Example: claude-nonstop add work');
    process.exit(1);
  }

  try {
    const configDir = addAccount(name);
    console.log(`Account "${name}" registered.`);
    console.log(`Config directory: ${configDir}`);
    console.log('');
    console.log('Opening browser for login...');
    console.log('');

    // Use `claude auth login` for non-interactive browser-based OAuth.
    // Strip CLAUDECODE env var so this works when called from inside a Claude Code session.
    const authEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    delete authEnv.CLAUDECODE;

    await new Promise((resolve) => {
      const child = spawn('claude', ['auth', 'login'], {
        env: authEnv,
        stdio: 'inherit',
      });

      child.on('close', () => resolve());
      child.on('error', (err) => {
        console.error(`Failed to launch Claude Code: ${err.message}`);
        console.error('Make sure "claude" is installed and in your PATH.');
        resolve();
      });
    });

    // Verify credentials were saved
    const creds = readCredentials(configDir);
    if (!creds.token) {
      console.log('');
      console.log(`Warning: No credentials found for "${name}".`);
      console.log(`You can login later by running: CLAUDE_CONFIG_DIR="${configDir}" claude auth login`);
      return;
    }

    console.log('');
    console.log(`Account "${name}" authenticated. Checking for duplicates...`);

    // Duplicate detection: compare profile email against existing accounts
    const newProfile = await fetchProfile(creds.token);
    if (newProfile.email) {
      const existingAccounts = getAccounts().filter(a => a.name !== name);
      const existingProfiles = await Promise.all(existingAccounts.map(async (a) => {
        const existingCreds = readCredentials(a.configDir);
        if (!existingCreds.token) return { ...a, email: null };
        const profile = await fetchProfile(existingCreds.token);
        return { ...a, email: profile.email };
      }));

      const duplicate = existingProfiles.find(a => a.email && a.email === newProfile.email);
      if (duplicate) {
        console.error(`\nError: "${name}" (${newProfile.email}) is the same account as "${duplicate.name}".`);
        console.error('Each account must be a different Claude subscription.');
        console.error(`Removing "${name}"...`);
        removeAccount(name);
        process.exit(1);
      }
    }

    console.log(`Account "${name}" added successfully.`);
    if (newProfile.email) console.log(`Email: ${newProfile.email}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdRemove(args) {
  const name = args[0];
  if (!name) {
    console.error('Usage: claude-nonstop remove <name>');
    process.exit(1);
  }

  try {
    removeAccount(name);
    console.log(`Account "${name}" removed.`);
    console.log('Note: Credentials in Keychain and config directory were not deleted.');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdReauth() {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log('No accounts registered.');
    return;
  }

  // Check which accounts have expired tokens
  console.log('Checking account credentials...\n');

  const accountsWithTokens = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token, expiresAt: creds.expiresAt, error: creds.error };
  });

  const withTokens = accountsWithTokens.filter(a => a.token);
  const noTokens = accountsWithTokens.filter(a => !a.token);

  // Pre-check: tokens expired per keychain expiresAt
  const localExpired = withTokens.filter(a => isTokenExpired({ expiresAt: a.expiresAt }));

  // Check usage API for remaining accounts that have non-expired tokens
  const toCheck = withTokens.filter(a => !isTokenExpired({ expiresAt: a.expiresAt }));
  let expired = [...noTokens, ...localExpired];
  if (toCheck.length > 0) {
    const withUsage = await checkAllUsage(toCheck);
    for (const a of withUsage) {
      if (a.usage?.error) {
        expired.push(a);
      }
    }
  }

  if (expired.length === 0) {
    console.log('All accounts are authenticated and working.');
    return;
  }

  console.log(`Found ${expired.length} account(s) needing re-authentication:\n`);
  for (const a of expired) {
    const reason = a.token
      ? (isTokenExpired({ expiresAt: a.expiresAt }) ? 'token expired' : `API error (${a.usage?.error || 'unknown'})`)
      : (a.error || 'no credentials');
    console.log(`  ${a.name}: ${reason}`);
  }
  console.log('');

  // First pass: try silent refresh for accounts that have tokens
  let successCount = 0;
  const stillExpired = [];
  const silentCandidates = expired.filter(a => a.token);

  if (silentCandidates.length > 0) {
    console.log('Attempting silent token refresh...');
    for (const account of silentCandidates) {
      if (await silentRefresh(account)) {
        console.log(`  ${account.name}: refreshed`);
        successCount++;
      } else {
        stillExpired.push(account);
      }
    }
    // Add accounts with no token (need browser login)
    stillExpired.push(...expired.filter(a => !a.token));
    console.log('');
  } else {
    stillExpired.push(...expired);
  }

  // Second pass: browser-based re-auth for remaining accounts
  for (let i = 0; i < stillExpired.length; i++) {
    console.log(`[${i + 1}/${stillExpired.length}]`);
    const success = await reauthAccount(stillExpired[i]);
    if (success) successCount++;
    console.log('');
  }

  console.log(`Re-authentication complete. ${successCount}/${expired.length} account(s) refreshed.`);
  console.log('Run "claude-nonstop status" to verify.');
}

async function cmdUpdate() {
  // Find the source git repo. The installed package (e.g. /opt/homebrew/lib/node_modules/...)
  // is not a git repo, so we search common locations for the cloned source.
  function isClaudeNonstopRepo(dir) {
    try {
      if (!existsSync(join(dir, 'package.json'))) return false;
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name !== 'claude-nonstop') return false;
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  const home = process.env.HOME || '';
  const candidates = [
    join(home, 'code', 'claude-nonstop'),
    join(home, 'src', 'claude-nonstop'),
    join(home, 'projects', 'claude-nonstop'),
    join(home, 'dev', 'claude-nonstop'),
    join(home, 'repos', 'claude-nonstop'),
  ];

  let repoDir = candidates.find(isClaudeNonstopRepo);

  if (!repoDir) {
    console.error('Could not find the claude-nonstop git repo.');
    console.error('Checked: ' + candidates.join(', '));
    console.error('\nClone it first:');
    console.error('  git clone https://github.com/rchaz/claude-nonstop.git ~/code/claude-nonstop');
    process.exit(1);
  }

  console.log(`Updating from ${repoDir}...\n`);

  // 1. Remind user to pull if there's a remote
  try {
    const remotes = execFileSync('git', ['remote'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    if (remotes) {
      console.log(`Tip: Run "cd ${repoDir} && git pull" first to get the latest changes.\n`);
    }
  } catch {}

  // 2. npm pack + install
  console.log('\nReinstalling...');
  try {
    const tgz = execFileSync('npm', ['pack'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    const tgzPath = join(repoDir, tgz);
    execFileSync('npm', ['install', '-g', tgzPath], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' });
    console.log(`  Installed ${tgz}`);
  } catch (err) {
    console.error(`  npm install failed: ${err.message}`);
    process.exit(1);
  }

  // 3. Reinstall hooks to pick up any new/changed hook types
  console.log('\nReinstalling hooks...');
  installHooksToAllProfiles();

  // 4. postinstall handles webhook restart, but verify
  if (isMacOS() && isServiceInstalled()) {
    console.log('\nWebhook service restarted by postinstall.');
  }

  console.log('\nUpdate complete.');
}

async function cmdList() {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log('No accounts registered.');
    console.log('Run "claude-nonstop add <name>" to register an account.');
    return;
  }

  console.log('Accounts:\n');

  // Read credentials and fetch profiles in parallel
  const enriched = await Promise.all(accounts.map(async (account) => {
    const creds = readCredentials(account.configDir);
    const profile = creds.token ? await fetchProfile(creds.token) : { name: null, email: null };
    return { ...account, creds, profile };
  }));

  for (const entry of enriched) {
    const status = entry.creds.token ? 'authenticated' : 'not authenticated';
    const userInfo = formatUserInfo(entry.profile);
    const priLabel = entry.priority != null ? ` (priority: ${entry.priority})` : '';
    console.log(`  ${entry.name}${userInfo}${priLabel}`);
    console.log(`    Config: ${entry.configDir}`);
    console.log(`    Status: ${status}`);
    console.log('');
  }
}

async function cmdStatus() {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log('No accounts registered.');
    return;
  }

  console.log('Checking usage for all accounts...\n');

  // Read credentials for all accounts
  const accountsWithTokens = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token };
  });

  const authenticated = accountsWithTokens.filter(a => a.token);
  const unauthenticated = accountsWithTokens.filter(a => !a.token);

  if (authenticated.length > 0) {
    // Fetch usage and profiles in parallel
    let [withUsage, profiles] = await Promise.all([
      checkAllUsage(authenticated),
      Promise.all(authenticated.map(a => fetchProfile(a.token))),
    ]);

    // Silent refresh: retry accounts with auth errors (401 expired, 403 revoked)
    const rejected = withUsage.filter(a =>
      a.usage?.error === 'HTTP 401' || a.usage?.error === 'HTTP 403'
    );
    if (rejected.length > 0) {
      for (const account of rejected) {
        if (await silentRefresh(account)) {
          // Re-read token and retry usage check
          const creds = readCredentials(account.configDir);
          if (creds.token) {
            account.token = creds.token;
            account.usage = await checkUsage(creds.token);
            // Re-fetch profile with refreshed token
            const profile = await fetchProfile(creds.token);
            const idx = authenticated.findIndex(a => a.name === account.name);
            if (idx !== -1) profiles[idx] = profile;
          }
        }
      }
    }

    // Merge profiles into usage results
    const profileMap = Object.fromEntries(authenticated.map((a, i) => [a.name, profiles[i]]));

    // Find best account for display
    const best = pickBestAccount(withUsage);
    const bestName = best?.account?.name;

    for (const account of withUsage) {
      const isBest = account.name === bestName;
      const marker = isBest ? ' <-- best' : '';
      const userInfo = formatUserInfo(profileMap[account.name] || {});
      const priLabel = account.priority != null ? ` (priority: ${account.priority})` : '';

      console.log(`  ${account.name}${userInfo}${priLabel}${marker}`);

      if (account.usage.error) {
        console.log(`    Usage: error (${account.usage.error})`);
      } else {
        const sessionBar = makeBar(account.usage.sessionPercent);
        const weeklyBar = makeBar(account.usage.weeklyPercent);
        console.log(`    5-hour:  ${sessionBar} ${account.usage.sessionPercent}%`);
        console.log(`    7-day:   ${weeklyBar} ${account.usage.weeklyPercent}%`);

        if (account.usage.sessionResetsAt) {
          console.log(`    Session resets: ${formatResetTime(account.usage.sessionResetsAt)}`);
        }
        if (account.usage.weeklyResetsAt) {
          console.log(`    Weekly resets:  ${formatResetTime(account.usage.weeklyResetsAt)}`);
        }
      }
      console.log('');
    }
  }

  if (unauthenticated.length > 0) {
    console.log('  Not authenticated:');
    for (const account of unauthenticated) {
      console.log(`    ${account.name} (${account.configDir})`);
    }
    console.log('');
  }
}

async function cmdRun(claudeArgs) {
  // Extract --remote-access flag (consume it, don't pass to claude)
  const remoteAccessIdx = claudeArgs.indexOf('--remote-access');
  const remoteAccess = remoteAccessIdx !== -1;
  if (remoteAccess) {
    claudeArgs.splice(remoteAccessIdx, 1);
  }

  // Extract --account / -a flag (consume it, don't pass to claude)
  const requestedAccount = extractAccountFlag(claudeArgs);

  // Handle tmux bootstrapping for remote access
  if (remoteAccess) {
    const { isInsideTmux, generateSessionName, reexecInTmux } = await import('../lib/tmux.js');

    if (!isInsideTmux()) {
      const sessionName = generateSessionName();
      console.error(`[claude-nonstop] Creating tmux session "${sessionName}"...`);
      reexecInTmux(sessionName, process.argv);
      return; // reexecInTmux calls process.exit, but just in case
    }

    // Inside tmux — inject --dangerously-skip-permissions if not already present
    if (!claudeArgs.includes('--dangerously-skip-permissions')) {
      claudeArgs.push('--dangerously-skip-permissions');
    }

    // Append formatting instruction for Slack readability
    if (!claudeArgs.includes('--append-system-prompt')) {
      claudeArgs.push(
        '--append-system-prompt',
        'Your responses are relayed to a Slack channel. Structure output for readability: use short paragraphs, bullet points, and bold headers (## Header). Separate sections with blank lines. Keep summaries concise — prefer a few clear bullets over long prose.'
      );
    }
  }

  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.error('No accounts registered. Run "claude-nonstop add <name>" first.');
    process.exit(1);
  }

  // Read credentials for all accounts
  let accountsWithCreds = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token, expiresAt: creds.expiresAt };
  });

  // Pre-flight: detect expired tokens and offer re-auth
  const expiredPreFlight = accountsWithCreds.filter(a =>
    !a.token || (a.expiresAt && isTokenExpired({ expiresAt: a.expiresAt }))
  );

  if (expiredPreFlight.length > 0 && !remoteAccess) {
    const refreshed = await reauthExpiredAccounts(expiredPreFlight);
    if (refreshed.length > 0) {
      // Re-read credentials for refreshed accounts
      accountsWithCreds = accounts.map(a => {
        const creds = readCredentials(a.configDir);
        return { ...a, token: creds.token, expiresAt: creds.expiresAt };
      });
    }
  }

  const authenticated = accountsWithCreds.filter(a => a.token);

  if (authenticated.length === 0) {
    console.error('No authenticated accounts. Run "claude-nonstop add <name>" to add and authenticate an account.');
    process.exit(1);
  }

  // Check usage and pick best account
  let selectedAccount;

  if (requestedAccount) {
    // Explicit --account flag — use it directly, skip usage check
    selectedAccount = authenticated.find(a => a.name === requestedAccount);
    if (!selectedAccount) {
      console.error(`Error: Account "${requestedAccount}" not found or not authenticated.`);
      console.error(`Authenticated accounts: ${authenticated.map(a => a.name).join(', ')}`);
      process.exit(1);
    }
    console.error(`[claude-nonstop] Using requested account "${selectedAccount.name}"`);
  } else if (authenticated.length === 1) {
    // Only one account — use it directly (skip usage check)
    selectedAccount = authenticated[0];
    console.error(`[claude-nonstop] Using account "${selectedAccount.name}"`);
  } else {
    // Multiple accounts — check usage and pick best
    console.error('[claude-nonstop] Checking usage across accounts...');
    const withUsage = await checkAllUsage(authenticated);

    // Check if any authenticated accounts have API auth errors (expired or revoked)
    const apiExpired = withUsage.filter(a =>
      a.usage?.error === 'HTTP 401' || a.usage?.error === 'HTTP 403'
    );
    if (apiExpired.length > 0 && !remoteAccess) {
      const refreshed = await reauthExpiredAccounts(apiExpired);
      if (refreshed.length > 0) {
        // Re-read credentials and re-check usage for refreshed accounts
        const updatedAccounts = accounts.map(a => {
          const creds = readCredentials(a.configDir);
          return { ...a, token: creds.token };
        }).filter(a => a.token);
        const updatedUsage = await checkAllUsage(updatedAccounts);
        // Merge: replace stale entries with refreshed ones
        for (const updated of updatedUsage) {
          const idx = withUsage.findIndex(a => a.name === updated.name);
          if (idx !== -1) withUsage[idx] = updated;
          else withUsage.push(updated);
        }
      }
    }

    const best = pickBestAccount(withUsage, undefined, { usePriority: true });

    if (best) {
      selectedAccount = best.account;
      console.error(`[claude-nonstop] Selected "${selectedAccount.name}" (${best.reason})`);
    } else {
      // Fallback to first authenticated account
      selectedAccount = authenticated[0];
      console.error(`[claude-nonstop] Defaulting to "${selectedAccount.name}"`);
    }
  }

  // Run with auto-switching
  await run(claudeArgs, selectedAccount, accounts, { remoteAccess });
}

async function cmdResume(resumeArgs) {
  // Extract --remote-access flag (consume it, don't pass to claude)
  const remoteAccessIdx = resumeArgs.indexOf('--remote-access');
  const remoteAccess = remoteAccessIdx !== -1;
  if (remoteAccess) {
    resumeArgs.splice(remoteAccessIdx, 1);
  }

  // Extract --account / -a flag (consume it, don't pass to claude)
  const requestedAccount = extractAccountFlag(resumeArgs);

  // Handle tmux bootstrapping for remote access
  if (remoteAccess) {
    const { isInsideTmux, generateSessionName, reexecInTmux } = await import('../lib/tmux.js');

    if (!isInsideTmux()) {
      const sessionName = generateSessionName();
      console.error(`[claude-nonstop] Creating tmux session "${sessionName}"...`);
      reexecInTmux(sessionName, process.argv);
      return;
    }
  }

  const accounts = getAccounts();
  if (accounts.length === 0) {
    console.error('No accounts registered. Run "claude-nonstop add <name>" first.');
    process.exit(1);
  }

  // Find session across all profiles
  const { findSessionAcrossProfiles, findLatestSessionAcrossProfiles, migrateSessionByHash } = await import('../lib/session.js');

  const sessionIdArg = resumeArgs.find(a => !a.startsWith('-'));
  let found;

  if (sessionIdArg) {
    console.error(`[claude-nonstop] Searching for session ${sessionIdArg}...`);
    found = findSessionAcrossProfiles(accounts, sessionIdArg);
    if (!found) {
      console.error(`Error: Session "${sessionIdArg}" not found in any account.`);
      process.exit(1);
    }
  } else {
    console.error('[claude-nonstop] Searching for most recent session in this project...');
    found = findLatestSessionAcrossProfiles(accounts, process.cwd());
    if (!found) {
      console.error('Error: No sessions found for this project in any account.');
      process.exit(1);
    }
  }

  const sessionId = sessionIdArg || found.sessionId;
  console.error(`[claude-nonstop] Found session ${sessionId} in account "${found.account.name}"`);

  // Build claude args
  const claudeArgs = ['--resume', sessionId];
  if (remoteAccess && !claudeArgs.includes('--dangerously-skip-permissions')) {
    claudeArgs.push('--dangerously-skip-permissions');
  }

  // Read credentials and pick best account (same as cmdRun)
  let accountsWithCreds = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token, expiresAt: creds.expiresAt };
  });

  const expiredPreFlight = accountsWithCreds.filter(a =>
    !a.token || (a.expiresAt && isTokenExpired({ expiresAt: a.expiresAt }))
  );

  if (expiredPreFlight.length > 0 && !remoteAccess) {
    const refreshed = await reauthExpiredAccounts(expiredPreFlight);
    if (refreshed.length > 0) {
      accountsWithCreds = accounts.map(a => {
        const creds = readCredentials(a.configDir);
        return { ...a, token: creds.token, expiresAt: creds.expiresAt };
      });
    }
  }

  const authenticated = accountsWithCreds.filter(a => a.token);
  if (authenticated.length === 0) {
    console.error('No authenticated accounts. Run "claude-nonstop add <name>" to add and authenticate an account.');
    process.exit(1);
  }

  // Pick best account
  let selectedAccount;

  if (requestedAccount) {
    // Explicit --account flag — use it directly, skip usage check
    selectedAccount = authenticated.find(a => a.name === requestedAccount);
    if (!selectedAccount) {
      console.error(`Error: Account "${requestedAccount}" not found or not authenticated.`);
      console.error(`Authenticated accounts: ${authenticated.map(a => a.name).join(', ')}`);
      process.exit(1);
    }
    console.error(`[claude-nonstop] Using requested account "${selectedAccount.name}"`);
  } else if (authenticated.length === 1) {
    selectedAccount = authenticated[0];
    console.error(`[claude-nonstop] Using account "${selectedAccount.name}"`);
  } else {
    console.error('[claude-nonstop] Checking usage across accounts...');
    const withUsage = await checkAllUsage(authenticated);

    const apiExpired = withUsage.filter(a =>
      a.usage?.error === 'HTTP 401' || a.usage?.error === 'HTTP 403'
    );
    if (apiExpired.length > 0 && !remoteAccess) {
      const refreshed = await reauthExpiredAccounts(apiExpired);
      if (refreshed.length > 0) {
        const updatedAccounts = accounts.map(a => {
          const creds = readCredentials(a.configDir);
          return { ...a, token: creds.token };
        }).filter(a => a.token);
        const updatedUsage = await checkAllUsage(updatedAccounts);
        for (const updated of updatedUsage) {
          const idx = withUsage.findIndex(a => a.name === updated.name);
          if (idx !== -1) withUsage[idx] = updated;
          else withUsage.push(updated);
        }
      }
    }

    const best = pickBestAccount(withUsage, undefined, { usePriority: true });

    if (best) {
      selectedAccount = best.account;
      console.error(`[claude-nonstop] Selected "${selectedAccount.name}" (${best.reason})`);
    } else {
      selectedAccount = authenticated[0];
      console.error(`[claude-nonstop] Defaulting to "${selectedAccount.name}"`);
    }
  }

  // Migrate session to selected account if it lives in a different profile
  if (found.account.configDir !== selectedAccount.configDir) {
    console.error(`[claude-nonstop] Migrating session from "${found.account.name}" to "${selectedAccount.name}"...`);
    const result = migrateSessionByHash(found.account.configDir, selectedAccount.configDir, found.cwdHash, sessionId);
    if (!result.success) {
      console.error(`[claude-nonstop] Migration failed: ${result.error}`);
      console.error(`[claude-nonstop] Falling back to source account "${found.account.name}"`);
      selectedAccount = found.account;
    }
  }

  await run(claudeArgs, selectedAccount, accounts, { remoteAccess });
}

// ─── Use & Priority Commands ────────────────────────────────────────────────

async function cmdUse(useArgs) {
  const flag = useArgs[0];

  // No args — show current active profile
  if (!flag) {
    const current = process.env.CLAUDE_CONFIG_DIR;
    if (current) {
      const accounts = getAccounts();
      const match = accounts.find(a => a.configDir === current);
      const label = match ? match.name : 'unknown';
      console.error(`Current: ${label} (${current})`);
    } else {
      console.error(`Current: default (${DEFAULT_CLAUDE_DIR})`);
    }
    return;
  }

  // --unset — revert to default
  if (flag === '--unset') {
    // stdout: eval-friendly command; stderr: human message
    console.log('unset CLAUDE_CONFIG_DIR');
    console.error(`Reverted to default account (${DEFAULT_CLAUDE_DIR})`);
    return;
  }

  // --best — pick lowest utilization (no priority)
  if (flag === '--best') {
    const accounts = getAccounts();
    const accountsWithCreds = accounts.map(a => {
      const creds = readCredentials(a.configDir);
      return { ...a, token: creds.token };
    });
    const authenticated = accountsWithCreds.filter(a => a.token);

    if (authenticated.length === 0) {
      console.error('Error: No authenticated accounts.');
      process.exit(1);
    }

    const withUsage = await checkAllUsage(authenticated);
    const best = pickBestAccount(withUsage);

    if (!best) {
      console.error('Error: No suitable accounts found.');
      process.exit(1);
    }

    console.log(`export CLAUDE_CONFIG_DIR="${best.account.configDir}"`);
    console.error(`Switched to "${best.account.name}" (${best.reason})`);
    return;
  }

  // --priority — pick by priority hierarchy (98% threshold)
  if (flag === '--priority') {
    const accounts = getAccounts();
    const accountsWithCreds = accounts.map(a => {
      const creds = readCredentials(a.configDir);
      return { ...a, token: creds.token };
    });
    const authenticated = accountsWithCreds.filter(a => a.token);

    if (authenticated.length === 0) {
      console.error('Error: No authenticated accounts.');
      process.exit(1);
    }

    const withUsage = await checkAllUsage(authenticated);
    const best = pickByPriority(withUsage);

    if (!best) {
      console.error('Error: No suitable accounts found.');
      process.exit(1);
    }

    console.log(`export CLAUDE_CONFIG_DIR="${best.account.configDir}"`);
    console.error(`Switched to "${best.account.name}" (${best.reason})`);
    return;
  }

  // Explicit account name
  const name = flag;
  const accounts = getAccounts();
  const account = accounts.find(a => a.name === name);

  if (!account) {
    console.error(`Error: Account "${name}" not found.`);
    console.error(`Available accounts: ${accounts.map(a => a.name).join(', ')}`);
    process.exit(1);
  }

  const creds = readCredentials(account.configDir);
  if (!creds.token) {
    console.error(`Warning: Account "${name}" is not authenticated. Run "claude-nonstop reauth" first.`);
  }

  console.log(`export CLAUDE_CONFIG_DIR="${account.configDir}"`);
  console.error(`Switched to "${account.name}" (${account.configDir})`);
}

async function cmdSetPriority(priorityArgs) {
  const name = priorityArgs[0];
  const priorityStr = priorityArgs[1];

  if (!name) {
    console.error('Usage: claude-nonstop set-priority <account> <number>');
    console.error('       claude-nonstop set-priority <account> clear');
    console.error('Example: claude-nonstop set-priority main 1');
    process.exit(1);
  }

  try {
    if (priorityStr === 'clear' || priorityStr === undefined) {
      if (priorityStr === 'clear') {
        clearAccountPriority(name);
        console.log(`Priority cleared for "${name}".`);
      } else {
        console.error('Usage: claude-nonstop set-priority <account> <number>');
        console.error('       claude-nonstop set-priority <account> clear');
        process.exit(1);
      }
    } else {
      const priority = parseInt(priorityStr, 10);
      if (isNaN(priority)) {
        console.error('Error: Priority must be a positive integer.');
        process.exit(1);
      }
      setAccountPriority(name, priority);
      console.log(`Priority for "${name}" set to ${priority}.`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// ─── Init (shell integration) ───────────────────────────────────────────────

function cmdInit(shell) {
  if (!shell || !['bash', 'zsh'].includes(shell)) {
    console.error('Usage: claude-nonstop init <bash|zsh>');
    console.error('');
    console.error('Add this to your shell config:');
    console.error('  # ~/.bashrc');
    console.error('  eval "$(claude-nonstop init bash)"');
    console.error('  # ~/.zshrc');
    console.error('  eval "$(claude-nonstop init zsh)"');
    process.exit(1);
  }

  // Output a shell function that wraps `claude-nonstop use` with eval.
  // stdout has export/unset commands, stderr has human-readable messages.
  // The wrapper captures stdout, evals it, and lets stderr pass through naturally.
  console.log(`
claude-nonstop() {
  if [ "\$1" = "use" ] && [ \$# -gt 1 ]; then
    local shell_code
    shell_code="\$(command claude-nonstop "\$@")"
    local exit_code=\$?
    if [ \$exit_code -eq 0 ] && [ -n "\$shell_code" ]; then
      eval "\$shell_code"
    fi
    return \$exit_code
  else
    command claude-nonstop "\$@"
  fi
}
`.trim());
}

// ─── Setup & Hooks Commands ─────────────────────────────────────────────────

async function cmdSetup(setupArgs = []) {
  if (setupArgs.includes('--help') || setupArgs.includes('-h') || setupArgs.includes('help')) {
    console.log(`
claude-nonstop setup — Configure Slack remote access

Usage:
  claude-nonstop setup                           Interactive setup (prompts for tokens)
  claude-nonstop setup --bot-token <tok> --app-token <tok>   Non-interactive
  claude-nonstop setup --from-env                Read tokens from environment

Options:
  --bot-token <tok>        Slack bot token (xoxb-...)
  --app-token <tok>        Slack app token (xapp-...)
  --from-env               Read SLACK_BOT_TOKEN, SLACK_APP_TOKEN from environment
  --invite-user-id <id>    Auto-invite your Slack user to session channels
  --channel-id <id>        Slack channel ID for single-channel mode
  --allowed-users <ids>    Comma-separated Slack user IDs allowed to send commands
  --channel-prefix <p>     Prefix for channel names (default: cn)
  --default-tmux-session <name>  Default tmux session for single-channel/DM mode

When --bot-token and --app-token are provided (or --from-env), setup runs
non-interactively. On macOS, setup also installs the webhook as a launchd service.
`.trim());
    return;
  }

  console.log('claude-nonstop Slack Remote Access Setup\n');

  const { flags, fromEnv } = parseSetupFlags(setupArgs);

  let botToken, appToken, channelId, allowedUsers, inviteUserId, channelPrefix, defaultTmux;

  if (fromEnv || (flags.botToken && flags.appToken)) {
    // Non-interactive mode: read from env vars and/or CLI flags
    if (fromEnv) {
      botToken = flags.botToken || process.env.SLACK_BOT_TOKEN || '';
      appToken = flags.appToken || process.env.SLACK_APP_TOKEN || '';
      channelId = flags.channelId || process.env.SLACK_CHANNEL_ID || '';
      allowedUsers = flags.allowedUsers || process.env.SLACK_ALLOWED_USERS || '';
      inviteUserId = flags.inviteUserId || process.env.SLACK_INVITE_USER_ID || '';
      channelPrefix = flags.channelPrefix || process.env.SLACK_CHANNEL_PREFIX || 'cn';
      defaultTmux = flags.defaultTmuxSession || process.env.DEFAULT_TMUX_SESSION || '';
      console.log('Reading configuration from environment variables...');
    } else {
      botToken = flags.botToken;
      appToken = flags.appToken;
      channelId = flags.channelId || '';
      allowedUsers = flags.allowedUsers || '';
      inviteUserId = flags.inviteUserId || '';
      channelPrefix = flags.channelPrefix || 'cn';
      defaultTmux = flags.defaultTmuxSession || '';
      console.log('Using tokens from CLI flags...');
    }
  } else {
    // Interactive mode (default)
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q, defaultVal = '') => new Promise((resolve) => {
      const prompt = defaultVal ? `${q} [${defaultVal}]: ` : `${q}: `;
      rl.question(prompt, (answer) => resolve(answer.trim() || defaultVal));
    });

    console.log('Enter your Slack app tokens.');
    console.log('Bot Token: Slack app > OAuth & Permissions (starts with xoxb-)');
    console.log('App Token: Slack app > Basic Information > App-Level Tokens (starts with xapp-)\n');

    botToken = await ask('SLACK_BOT_TOKEN (xoxb-...)');
    appToken = await ask('SLACK_APP_TOKEN (xapp-...)');
    channelId = await ask('SLACK_CHANNEL_ID (optional, for single-channel mode)', '');
    allowedUsers = await ask('SLACK_ALLOWED_USERS (comma-separated user IDs, empty = all)', '');
    inviteUserId = await ask('SLACK_INVITE_USER_ID (auto-invite to session channels)', '');
    channelPrefix = await ask('SLACK_CHANNEL_PREFIX', 'cn');
    defaultTmux = await ask('DEFAULT_TMUX_SESSION (for single-channel/DM mode, optional)', '');

    rl.close();
  }

  // Validate required tokens
  if (!botToken || !botToken.startsWith('xoxb-')) {
    console.error('Invalid bot token. Must start with xoxb-');
    process.exit(1);
  }

  if (!appToken || !appToken.startsWith('xapp-')) {
    console.error('Invalid app token. Must start with xapp-');
    process.exit(1);
  }

  // Write .env
  const envContent = `# claude-nonstop Slack Configuration
SLACK_BOT_TOKEN=${botToken}
SLACK_APP_TOKEN=${appToken}
SLACK_CHANNEL_ID=${channelId}
SLACK_ALLOWED_USERS=${allowedUsers}
SLACK_INVITE_USER_ID=${inviteUserId}
SLACK_CHANNEL_PREFIX=${channelPrefix}
DEFAULT_TMUX_SESSION=${defaultTmux}
`;

  const envDir = CONFIG_DIR;
  if (!existsSync(envDir)) mkdirSync(envDir, { recursive: true });
  const envPath = join(envDir, '.env');
  // Atomic write with restrictive permissions (contains Slack tokens)
  const envTmp = join(envDir, `.env.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(envTmp, envContent, { mode: 0o600 });
  renameSync(envTmp, envPath);
  console.log(`\nWrote ${envPath}`);

  // Install hooks
  console.log('\nInstalling Claude Code hooks into all profiles...\n');
  installHooksToAllProfiles();

  // Auto-install launchd service on macOS
  if (isMacOS()) {
    console.log('\nInstalling webhook as launchd service...');
    try {
      installService();
      console.log('  Webhook service installed and started.');
      console.log(`  Logs: ${LOG_PATH}`);
    } catch (err) {
      console.warn(`  Warning: Could not install service: ${err.message}`);
      console.warn('  You can install it manually with: claude-nonstop webhook install');
    }
  }

  console.log('\nSetup complete! Next steps:');
  if (isMacOS()) {
    console.log('  1. Check webhook status: claude-nonstop webhook status');
    console.log('  2. Run with remote:      claude-nonstop --remote-access');
  } else {
    console.log('  1. Start the webhook:    claude-nonstop webhook');
    console.log('     (or set up a systemd service for auto-restart)');
    console.log('  2. Run with remote:      claude-nonstop --remote-access');
  }
}

async function cmdWebhook(subArgs = []) {
  const subcommand = subArgs[0];

  switch (subcommand) {
    case 'install':
      cmdWebhookInstall();
      break;

    case 'uninstall':
      cmdWebhookUninstall();
      break;

    case 'restart':
      cmdWebhookRestart();
      break;

    case 'status':
      cmdWebhookStatus();
      break;

    case 'logs':
      cmdWebhookLogs();
      break;

    case undefined:
      // No subcommand — show usage
      console.log('Usage:');
      console.log('  claude-nonstop webhook              Run webhook in foreground');
      console.log('  claude-nonstop webhook install      Install as launchd service (macOS)');
      console.log('  claude-nonstop webhook uninstall    Remove launchd service');
      console.log('  claude-nonstop webhook restart      Restart the service');
      console.log('  claude-nonstop webhook status       Show service status');
      console.log('  claude-nonstop webhook logs         Tail the webhook log');
      console.log('');
      console.log('To run in foreground (for debugging): claude-nonstop webhook start');
      break;

    case 'start':
      // Explicit foreground mode
      cmdWebhookForeground();
      break;

    default:
      console.error(`Unknown webhook subcommand: ${subcommand}`);
      console.error('Run "claude-nonstop help" for usage information.');
      process.exit(1);
  }
}

function cmdWebhookForeground() {
  const webhookPath = join(PROJECT_ROOT, 'remote', 'start-webhook.cjs');
  const child = spawn('node', [webhookPath], { stdio: 'inherit' });

  child.on('error', (err) => {
    console.error(`Failed to start webhook: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code || 0);
  });

  // Forward signals
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

function cmdWebhookInstall() {
  if (!isMacOS()) {
    console.error('Service management is only supported on macOS (launchd).');
    console.error('On Linux, use systemd or run "claude-nonstop webhook" in a screen/tmux session.');
    process.exit(1);
  }

  try {
    installService();
    console.log('Webhook service installed and started.');
    console.log(`  Service: claude-nonstop-slack`);
    console.log(`  Logs:    ${LOG_PATH}`);
    console.log('');
    console.log('The webhook will start automatically on login and restart on failure.');
    console.log('Use "claude-nonstop webhook status" to check status.');
  } catch (err) {
    console.error(`Failed to install service: ${err.message}`);
    process.exit(1);
  }
}

function cmdWebhookUninstall() {
  if (!isMacOS()) {
    console.error('Service management is only supported on macOS (launchd).');
    process.exit(1);
  }

  try {
    uninstallService();
    console.log('Webhook service stopped and removed.');
  } catch (err) {
    console.error(`Failed to uninstall service: ${err.message}`);
    process.exit(1);
  }
}

function cmdWebhookRestart() {
  if (!isMacOS()) {
    console.error('Service management is only supported on macOS (launchd).');
    process.exit(1);
  }

  if (!isServiceInstalled()) {
    console.error('Webhook service is not installed. Run "claude-nonstop webhook install" first.');
    process.exit(1);
  }

  try {
    restartService();
    console.log('Webhook service restarted.');
  } catch (err) {
    console.error(`Failed to restart service: ${err.message}`);
    process.exit(1);
  }
}

function cmdWebhookStatus() {
  if (!isMacOS()) {
    console.log('Service management is only supported on macOS (launchd).');
    console.log('Check webhook manually: ps aux | grep start-webhook');
    return;
  }

  const status = getServiceStatus();

  if (!status.installed) {
    console.log('Webhook service: not installed');
    console.log('Run "claude-nonstop webhook install" to install.');
    return;
  }

  console.log(`Webhook service: installed`);
  console.log(`  Status:  ${status.running ? 'running' : 'stopped'}`);
  if (status.pid) {
    console.log(`  PID:     ${status.pid}`);
  }
  console.log(`  Logs:    ${LOG_PATH}`);
}

function cmdWebhookLogs() {
  if (!existsSync(LOG_PATH)) {
    console.error(`No log file found at ${LOG_PATH}`);
    console.error('The webhook service may not have been started yet.');
    process.exit(1);
  }

  const child = spawn('tail', ['-f', LOG_PATH], { stdio: 'inherit' });

  child.on('error', (err) => {
    console.error(`Failed to tail logs: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code || 0);
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

async function cmdHooks(args) {
  const subcommand = args[0];

  if (subcommand === 'install') {
    installHooksToAllProfiles();
  } else if (subcommand === 'status') {
    showHooksStatus();
  } else {
    console.log('Usage:');
    console.log('  claude-nonstop hooks install   Install hooks into all profile settings');
    console.log('  claude-nonstop hooks status    Show hook status for all profiles');
  }
}

function getHookCommand(hookType) {
  const hookScript = join(PROJECT_ROOT, 'remote', 'hook-notify.cjs');
  const typeArg = {
    'Stop': 'completed',
    'SessionStart': 'session-start',
    'PostToolUse': 'tool-use',
    'PreToolUse': 'waiting-for-input',
  }[hookType];
  return `node "${hookScript}" ${typeArg}`;
}

function installHooksToAllProfiles() {
  const accounts = getAccounts();
  const hookScript = join(PROJECT_ROOT, 'remote', 'hook-notify.cjs');

  if (!existsSync(hookScript)) {
    console.error(`Hook script not found: ${hookScript}`);
    process.exit(1);
  }

  const hookTypes = ['Stop', 'SessionStart', 'PostToolUse', 'PreToolUse'];

  for (const account of accounts) {
    const settingsPath = join(account.configDir, 'settings.json');
    let settings = {};

    if (existsSync(settingsPath)) {
      try {
        let raw = readFileSync(settingsPath, 'utf8');
        // Strip ANSI escape codes if present (corrupted by terminal color output)
        raw = raw.replace(/\x1b\[[0-9;]*m/g, '');
        settings = JSON.parse(raw);
      } catch {
        console.warn(`  Warning: Could not parse ${settingsPath}, preserving skipDangerousModePermissionPrompt`);
        settings = { skipDangerousModePermissionPrompt: true };
      }
    }

    if (!settings.hooks) settings.hooks = {};

    for (const hookType of hookTypes) {
      const command = getHookCommand(hookType);
      const hookEntry = {
        type: 'command',
        command,
      };
      // SessionStart needs a timeout since it makes API calls
      if (hookType === 'SessionStart') {
        hookEntry.timeout = 10;
      }
      // PostToolUse runs async so it doesn't block Claude's agentic loop
      if (hookType === 'PostToolUse') {
        hookEntry.timeout = 15;
      }
      // PreToolUse for waiting-for-input needs a timeout for Slack API calls
      if (hookType === 'PreToolUse') {
        hookEntry.timeout = 15;
      }

      const matcher = { matcher: '', hooks: [hookEntry] };
      // PreToolUse only fires for tools that pause Claude for user input
      if (hookType === 'PreToolUse') {
        matcher.matcher = 'ExitPlanMode|AskUserQuestion';
      }
      // PostToolUse and PreToolUse must not block Claude Code
      if (hookType === 'PostToolUse' || hookType === 'PreToolUse') {
        matcher.async = true;
      }

      // Remove old Claude-Code-Remote hooks and any previous version of our hook
      if (settings.hooks[hookType]) {
        settings.hooks[hookType] = settings.hooks[hookType].filter(m => {
          if (!m.hooks) return true;
          // Remove matchers whose only hook is an old claude-hook-notify or hook-notify
          const isOldHook = m.hooks.every(h =>
            h.command?.includes('claude-hook-notify.js') ||
            h.command?.includes('hook-notify.cjs')
          );
          return !isOldHook;
        });
      }

      // Add our hook
      if (!settings.hooks[hookType]) {
        settings.hooks[hookType] = [];
      }
      settings.hooks[hookType].push(matcher);
    }

    // Ensure the settings directory exists
    const settingsDir = dirname(settingsPath);
    if (!existsSync(settingsDir)) {
      mkdirSync(settingsDir, { recursive: true });
    }

    const tmpSettings = join(settingsDir, `.settings.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmpSettings, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmpSettings, settingsPath);
    console.log(`  Installed hooks: ${account.name} (${settingsPath})`);
  }

  console.log(`\nHooks installed for ${accounts.length} profile(s).`);
}

function showHooksStatus() {
  const accounts = getAccounts();
  const hookTypes = ['Stop', 'SessionStart', 'PostToolUse', 'PreToolUse'];

  for (const account of accounts) {
    console.log(`\n  ${account.name} (${account.configDir})`);
    const settingsPath = join(account.configDir, 'settings.json');

    if (!existsSync(settingsPath)) {
      console.log('    No settings.json found');
      continue;
    }

    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));

      for (const hookType of hookTypes) {
        const hooks = settings.hooks?.[hookType];
        if (!hooks) {
          console.log(`    ${hookType}: not configured`);
          continue;
        }

        const hasOurHook = hooks.some(m =>
          m.hooks?.some(h => h.command?.includes('hook-notify.cjs'))
        );
        console.log(`    ${hookType}: ${hasOurHook ? 'installed' : 'missing (other hooks present)'}`);
      }
    } catch {
      console.log('    Error reading settings.json');
    }
  }
  console.log('');
}

// ─── Uninstall ──────────────────────────────────────────────────────────────────

async function cmdUninstall(uninstallArgs = []) {
  const force = uninstallArgs.includes('--force');

  if (!force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question('This will remove claude-nonstop completely. Continue? [y/N] ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  // 1. Stop and remove launchd service
  if (isMacOS() && isServiceInstalled()) {
    console.log('Stopping webhook service...');
    try {
      uninstallService();
      console.log('  Webhook service removed.');
    } catch (err) {
      console.warn(`  Warning: ${err.message}`);
    }
  }

  // 2. Remove our hooks from all profiles' settings.json
  console.log('Removing hooks from settings...');
  removeHooksFromAllProfiles();

  // 3. Remove keychain credentials for non-default accounts
  const accounts = getAccounts();
  const keychainAccounts = accounts.filter(a => a.configDir !== DEFAULT_CLAUDE_DIR);
  if (keychainAccounts.length > 0) {
    console.log('Removing keychain credentials...');
    for (const account of keychainAccounts) {
      const result = deleteKeychainEntry(account.configDir);
      if (result.deleted) {
        console.log(`  ${account.name}: removed`);
      } else if (result.error) {
        console.warn(`  ${account.name}: warning: ${result.error}`);
      } else {
        console.log(`  ${account.name}: not found (already clean)`);
      }
    }
  }

  // 4. Remove ~/.claude-nonstop/ directory
  if (existsSync(CONFIG_DIR)) {
    console.log(`Removing ${CONFIG_DIR}...`);
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    console.log('  Config directory removed.');
  }

  // 5. npm unlink
  console.log('Unlinking CLI...');
  try {
    const child = spawn('npm', ['unlink', '--global', 'claude-nonstop'], { stdio: 'pipe' });
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    if (exitCode === 0) {
      console.log('  CLI unlinked.');
    } else {
      console.warn('  Warning: npm unlink exited with code', exitCode);
      console.warn('  You may need to run "npm unlink -g claude-nonstop" manually.');
    }
  } catch {
    console.warn('  Warning: npm unlink failed. You may need to run "npm unlink -g claude-nonstop" manually.');
  }

  console.log('\nclaude-nonstop has been uninstalled.');
}

function removeHooksFromAllProfiles() {
  // Remove hooks from all known profile settings AND the default ~/.claude
  const accounts = getAccounts();

  // Collect all settings.json paths (profiles + default)
  const settingsPaths = accounts.map(a => join(a.configDir, 'settings.json'));

  // Also check default ~/.claude/settings.json if not already in accounts
  const defaultSettings = join(DEFAULT_CLAUDE_DIR, 'settings.json');
  if (!settingsPaths.includes(defaultSettings)) {
    settingsPaths.push(defaultSettings);
  }

  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;

    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) continue;

      let modified = false;
      for (const hookType of ['Stop', 'SessionStart', 'PostToolUse', 'PreToolUse']) {
        if (!settings.hooks[hookType]) continue;

        const filtered = settings.hooks[hookType].filter(m => {
          if (!m.hooks) return true;
          const isOurHook = m.hooks.every(h =>
            h.command?.includes('hook-notify.cjs')
          );
          return !isOurHook;
        });

        if (filtered.length !== settings.hooks[hookType].length) {
          settings.hooks[hookType] = filtered;
          modified = true;
        }

        // Remove empty hook arrays
        if (settings.hooks[hookType].length === 0) {
          delete settings.hooks[hookType];
        }
      }

      // Remove empty hooks object
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      if (modified) {
        const settingsDir = dirname(settingsPath);
        const tmpSettings = join(settingsDir, `.settings.${process.pid}.${Date.now()}.tmp`);
        writeFileSync(tmpSettings, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
        renameSync(tmpSettings, settingsPath);
        console.log(`  Removed hooks: ${settingsPath}`);
      }
    } catch {
      // Skip files we can't parse
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseSetupFlags(args) {
  const flags = {};
  let fromEnv = false;

  const flagMap = {
    '--bot-token': 'botToken',
    '--app-token': 'appToken',
    '--channel-id': 'channelId',
    '--allowed-users': 'allowedUsers',
    '--invite-user-id': 'inviteUserId',
    '--channel-prefix': 'channelPrefix',
    '--default-tmux-session': 'defaultTmuxSession',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--from-env') {
      fromEnv = true;
      continue;
    }

    // Handle --flag=value
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      const key = arg.substring(0, eqIdx);
      const value = arg.substring(eqIdx + 1);
      if (flagMap[key]) {
        flags[flagMap[key]] = value;
        continue;
      }
    }

    // Handle --flag value
    if (flagMap[arg] && i + 1 < args.length) {
      flags[flagMap[arg]] = args[i + 1];
      i++;
      continue;
    }
  }

  return { flags, fromEnv };
}

/**
 * Extract --account <name> or -a <name> from args array.
 * Splices the flag and value out of the array in-place.
 * Returns the account name string, or null if not specified.
 */
function extractAccountFlag(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account' || args[i] === '-a') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error(`Error: ${args[i]} requires an account name.`);
        process.exit(1);
      }
      const name = args[i + 1];
      args.splice(i, 2);
      return name;
    }
  }
  return null;
}

function printHelp() {
  console.log(`
claude-nonstop — Multi-account switching + Slack remote access for Claude Code

Usage:
  claude-nonstop                       Run Claude (best account, auto-switching)
  claude-nonstop -p "prompt"           One-shot prompt
  claude-nonstop status                Show usage across all accounts
  claude-nonstop --remote-access       Run with tmux + Slack channels

Commands:
  status               Show usage with progress bars and reset times
  add <name>           Add a new Claude account
  remove <name>        Remove an account
  list                 List accounts with auth status
  reauth               Re-authenticate expired accounts
  resume [id]          Resume most recent session, or a specific one by ID
  init <bash|zsh>      Shell integration (add to ~/.bashrc or ~/.zshrc):
                         eval "$(claude-nonstop init bash)"
  use [name|flag]      Switch active account for current shell (Agent SDK, etc.)
                         use <name>       Explicit account
                         use --best       Lowest utilization (ignores priority)
                         use --priority   Highest priority under 98% usage
                         use --unset      Revert to default ~/.claude
                         use              Show current active account
  set-priority <name> <n>  Set account priority (1 = highest). Use "clear" to remove.
  setup                Configure Slack remote access
  webhook              Webhook service management
  hooks                Hook management
  update               Reinstall from local source
  uninstall            Remove claude-nonstop completely

Options:
  -a, --account <name>    Use a specific account
  --remote-access         Run in tmux with Slack channels

All other arguments are passed through to \`claude\`.
Run \`setup --help\`, \`webhook\`, or \`hooks\` for subcommand details.
`.trim());
}

function formatUserInfo({ name, email }) {
  if (name && email) return ` (${name} — ${email})`;
  if (name) return ` (${name})`;
  if (email) return ` (${email})`;
  return '';
}

function makeBar(percent, width = 20) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  if (percent >= 95) return `\x1b[31m${bar}\x1b[0m`; // Red
  if (percent >= 70) return `\x1b[33m${bar}\x1b[0m`; // Yellow
  return `\x1b[32m${bar}\x1b[0m`; // Green
}

function formatResetTime(isoString) {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();

    if (diffMs <= 0) return 'now';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) return `in ${hours}h ${minutes}m`;
    return `in ${minutes}m`;
  } catch {
    return isoString;
  }
}
