/**
 * Process runner — spawns Claude Code, monitors output for rate limits,
 * and automatically switches accounts with session migration.
 *
 * Flow:
 * 1. Spawn `claude` with CLAUDE_CONFIG_DIR pointing to selected account
 * 2. Pipe stdout/stderr through to the user's terminal (real-time pass-through)
 * 3. Simultaneously scan output for rate limit patterns
 * 4. On rate limit detection:
 *    a. Kill the paused Claude process
 *    b. Find the active session file
 *    c. Migrate session to the next best account's config dir
 *    d. Resume with `claude --resume <sessionId>` using the new account
 */

import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readCredentials } from './keychain.js';
import { checkAllUsage, checkUsage } from './usage.js';
import { pickBestAccount, effectiveUtilization } from './scorer.js';
import { findLatestSession, migrateSession } from './session.js';
import { reauthExpiredAccounts } from './reauth.js';
import { CONFIG_DIR } from './config.js';
import { getCurrentTmuxSession } from './tmux.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_NOTIFY_PATH = path.resolve(__dirname, '..', 'remote', 'hook-notify.cjs');

// ─── Diagnostic Logging ────────────────────────────────────────────────────
// Mirror console.error to a date-rotated log file. Required because the
// claude PTY repaints the screen on (re)launch and rate-limit-swap decisions
// printed to stderr scroll out of the user's terminal before they can be
// read. The log lets us see *why* a swap or exit happened post-mortem.
const RUNNER_LOG_PATH = path.join(
  CONFIG_DIR,
  `runner-${new Date().toISOString().slice(0, 10)}.log`,
);
const _origConsoleError = console.error.bind(console);
console.error = (...args) => {
  _origConsoleError(...args);
  try {
    const line = args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    fs.appendFileSync(RUNNER_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};

/**
 * Rate limit detection pattern.
 * Claude Code outputs either:
 *   "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"
 *   "You've hit your limit · resets 8am (America/Los_Angeles)"
 */
const RATE_LIMIT_PATTERN = /(?:Limit reached|You've hit your limit)\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im;

/**
 * Admin/weekly-cap disable pattern.
 * Claude Code outputs "Your usage allocation has been disabled by your admin"
 * when an account hits a weekly cap or is admin-disabled. No "resets" token
 * is included.
 *
 * NOTE: This message can also appear as a transient false positive (e.g., the
 * string leaking through sub-agent output, or a brief server-side flap) on an
 * account that still has plenty of headroom. Detection here only marks the
 * candidate; the runner verifies against the OAuth usage API before swapping
 * (see ADMIN_DISABLE_VERIFY_THRESHOLD).
 */
const ADMIN_DISABLED_PATTERN = /Your usage allocation has been disabled by your admin/i;

/**
 * When an admin-disabled message is detected, the runner re-queries the OAuth
 * usage API for the current account. If both 5h and 7d utilization are below
 * this threshold, the message is treated as a false positive and the same
 * account is restarted instead of triggering a swap.
 */
const ADMIN_DISABLE_VERIFY_THRESHOLD = 95;

/**
 * Cap on consecutive admin-disabled false-positive restarts on the same
 * account. After this many in a row, fall through to the normal swap path
 * to avoid a tight restart loop if the message keeps recurring.
 */
const MAX_CONSECUTIVE_ADMIN_FALSE_POSITIVES = 3;

/** Maximum output buffer size before trimming (bytes). */
const OUTPUT_BUFFER_MAX = 4000;
/** Buffer trim target (bytes). */
const OUTPUT_BUFFER_TRIM = 2000;
/** Maximum number of account swaps before giving up. */
const MAX_SWAPS_DEFAULT = 5;
/** Message sent to auto-continue after rate-limit account switch. */
const RATE_LIMIT_CONTINUE_MSG = 'Continue.';
/** Time to wait before SIGKILL after SIGTERM (ms). */
const KILL_ESCALATION_DELAY = 3000;
/** Utilization threshold (%) at which all accounts are considered near-exhausted. */
const EXHAUSTION_THRESHOLD = 99;
/** Maximum sleep duration when waiting for a rate limit reset (6 hours). */
const MAX_SLEEP_MS = 6 * 60 * 60 * 1000;

/**
 * Claude Code interactive input box marker.
 * The prompt line looks like `│ > …` once the UI is fully drawn (i.e. after
 * any session-resume replay finishes). Used as the primary gate for
 * rate-limit detection so we don't match against replayed conversation
 * history that happens to contain a prior "Limit reached · resets …"
 * message.
 */
const PROMPT_MARKER_PATTERN = /│\s*>/;

/**
 * Time after spawn before the rate-limit detector activates unconditionally
 * (timeout fallback for environments where the prompt marker never appears,
 * e.g., the workspace-trust dialog blocks UI render). Tradeoff: a real
 * startup-time rate-limit hitting before the gate opens may be missed, but
 * that is far less harmful than false-positive thrashing across all
 * accounts triggered by replayed conversation content.
 */
const SPAWN_GRACE_MS = 4000;

// ─── ANSI Stripping ────────────────────────────────────────────────────────

/** Strip ANSI escape codes (colors, cursor, etc.) from PTY output. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// ─── Rate-Limit Detector ──────────────────────────────────────────────────

/**
 * Stateful detector that scans PTY output for rate-limit and admin-disabled
 * messages while suppressing false positives caused by `claude --resume`
 * replaying past conversation content (which may contain prior
 * "Limit reached · resets …" text).
 *
 * Gate logic (A+B):
 *   A) Marker — once the claude-code input prompt (`│ >`) is observed, the
 *      UI is fully drawn and any replay has completed. Buffer is reset and
 *      detection is enabled from this point on.
 *   B) Timeout — if the marker never appears (e.g., trust dialog blocks
 *      render), `fireTimeout()` is called externally to force the gate
 *      open. Pre-timeout buffer is discarded for the same reason.
 *
 * Either condition opens the gate; whichever fires first wins.
 */
function createRateLimitDetector(options = {}) {
  const markerPattern = options.markerPattern ?? PROMPT_MARKER_PATTERN;
  const bufferMax = options.bufferMax ?? OUTPUT_BUFFER_MAX;
  const bufferTrim = options.bufferTrim ?? OUTPUT_BUFFER_TRIM;

  let outputBuffer = '';
  let markerSeen = false;
  let timeoutFired = false;
  let rateLimitDetected = false;
  let resetTime = null;

  const gateOpen = () => markerSeen || timeoutFired;

  return {
    feed(chunk) {
      outputBuffer += chunk;
      if (outputBuffer.length > bufferMax) {
        outputBuffer = outputBuffer.slice(-bufferTrim);
      }

      let stripped = stripAnsi(outputBuffer);

      // Marker activation: clear buffer so replayed pre-prompt content
      // (which may contain stale "Limit reached" text) is not scanned.
      if (!markerSeen && markerPattern.test(stripped)) {
        markerSeen = true;
        outputBuffer = '';
        stripped = '';
      }

      if (!gateOpen() || rateLimitDetected) return null;

      const match = stripped.match(RATE_LIMIT_PATTERN);
      if (match) {
        rateLimitDetected = true;
        resetTime = match[1].trim();
        return { resetTime, kind: 'rate-limit' };
      }
      if (ADMIN_DISABLED_PATTERN.test(stripped)) {
        rateLimitDetected = true;
        resetTime = null;
        return { resetTime: null, kind: 'admin-disabled' };
      }
      return null;
    },

    fireTimeout() {
      if (timeoutFired) return;
      timeoutFired = true;
      // Discard pre-timeout buffer for the same reason as marker activation:
      // anything observed before the gate opens is presumed to be replay
      // residue, not live output.
      outputBuffer = '';
    },

    isMarkerSeen() { return markerSeen; },
    isGateOpen() { return gateOpen(); },
    isRateLimitDetected() { return rateLimitDetected; },
    getResetTime() { return resetTime; },
  };
}

/**
 * Spawn hook-notify.cjs fire-and-forget with data on stdin.
 */
function spawnHookNotify(type, data) {
  const child = execFile('node', [HOOK_NOTIFY_PATH, type], {
    timeout: 15_000,
    stdio: ['pipe', 'ignore', 'ignore'],
  }, () => {});
  child.stdin.write(JSON.stringify(data));
  child.stdin.end();
  child.unref();
}

/**
 * Find the earliest reset time across all non-excluded accounts.
 *
 * @param {Array<{name: string, usage: object}>} accounts
 * @param {string} [excludeName] - Account name to skip
 * @returns {number} Milliseconds until earliest reset (0 if no reset info available)
 */
function findEarliestReset(accounts, excludeName) {
  const now = Date.now();
  let earliest = Infinity;

  for (const a of accounts) {
    if (a.name === excludeName) continue;
    if (!a.usage) continue;

    for (const ts of [a.usage.sessionResetsAt, a.usage.weeklyResetsAt]) {
      if (!ts) continue;
      const resetMs = new Date(ts).getTime();
      if (isNaN(resetMs)) continue;
      if (resetMs > now && resetMs < earliest) {
        earliest = resetMs;
      }
    }
  }

  if (earliest === Infinity) return 0;
  return earliest - now;
}

/**
 * Format a duration in ms to a human-readable string like "2h 15m".
 */
function formatDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Sleep for the given number of milliseconds.
 * Interruptible: SIGINT or SIGTERM will resolve the sleep early.
 *
 * @param {number} ms
 * @returns {Promise<{ interrupted: boolean }>}
 */
function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ interrupted: false });
    }, ms);

    function onSignal() {
      cleanup();
      resolve({ interrupted: true });
    }

    function cleanup() {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

/**
 * Deactivate stale channel-map entries for a tmux session.
 * Called at startup so that reuseChannelForTmuxSession only matches
 * entries created during the current invocation (e.g., /clear or rate-limit restart),
 * not leftover entries from a previous run.
 *
 * @param {string} tmuxSessionName - The tmux session name to match
 * @param {string} [channelMapPath] - Path to channel-map.json (default: CONFIG_DIR/data/channel-map.json)
 */
function deactivateStaleChannels(tmuxSessionName, channelMapPath) {
  if (!channelMapPath) {
    channelMapPath = path.join(CONFIG_DIR, 'data', 'channel-map.json');
  }
  try {
    if (!fs.existsSync(channelMapPath)) return;
    const raw = fs.readFileSync(channelMapPath, 'utf8');
    if (!raw.trim()) return;
    const map = JSON.parse(raw);

    let changed = false;
    for (const entry of Object.values(map)) {
      if (entry.tmuxSession === tmuxSessionName && entry.active) {
        entry.active = false;
        changed = true;
      }
    }

    if (changed) {
      const dir = path.dirname(channelMapPath);
      const tmpFile = path.join(dir, `.channel-map.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmpFile, JSON.stringify(map, null, 2), { mode: 0o600 });
      fs.renameSync(tmpFile, channelMapPath);
    }
  } catch {
    // Non-fatal — channel reuse is a convenience, not critical
  }
}

/**
 * Run Claude Code with automatic account switching.
 *
 * @param {string[]} claudeArgs - Arguments to pass to `claude`
 * @param {{ name: string, configDir: string }} selectedAccount - Account to use
 * @param {Array<{ name: string, configDir: string }>} allAccounts - All registered accounts
 * @param {{ maxSwaps?: number, remoteAccess?: boolean }} options - Runner options
 */
export async function run(claudeArgs, selectedAccount, allAccounts, options = {}) {
  // Scale swap budget with account count — with N accounts, you may need
  // N-1 swaps to try them all before exhaustion triggers the sleep mechanism.
  // The * 2 multiplier allows for accounts recovering mid-session (5-hour resets).
  const maxSwaps = options.maxSwaps ?? Math.max(MAX_SWAPS_DEFAULT, allAccounts.length * 2);
  const remoteAccess = options.remoteAccess ?? false;
  let currentAccount = selectedAccount;
  let swapCount = 0;
  let sessionId = extractResumeSessionId(claudeArgs);
  // Counts admin-disabled detections that the OAuth usage API contradicted
  // (i.e., usage well below limit). Reset on a confirmed rate-limit or after
  // a real swap. Used to break out of restart loops if the false positive
  // keeps recurring on the same account.
  let consecutiveAdminFalsePositives = 0;

  // Deactivate stale channel entries from previous invocations so that
  // reuseChannelForTmuxSession only matches entries from this run
  // (i.e., /clear or rate-limit restarts within the same tmux session).
  if (remoteAccess) {
    deactivateStaleChannels(getCurrentTmuxSession());
  }

  while (swapCount <= maxSwaps) {
    const result = await runOnce(claudeArgs, currentAccount, sessionId, { remoteAccess });

    if (result.exitCode !== null && !result.rateLimitDetected) {
      // Normal exit — propagate the exit code
      process.exitCode = result.exitCode;
      return;
    }

    if (!result.rateLimitDetected) {
      // Process ended without rate limit (e.g., signal)
      process.exitCode = result.exitCode ?? 1;
      return;
    }

    // Admin-disabled false-positive guard:
    // The "Your usage allocation has been disabled by your admin" string can
    // surface transiently on accounts that still have plenty of headroom
    // (e.g., briefly leaked through sub-agent output, or a server-side flap).
    // Verify against the OAuth usage API before counting this as a real swap;
    // otherwise the runner will ping-pong across accounts that are not
    // actually rate-limited.
    if (result.detectionKind === 'admin-disabled' &&
        consecutiveAdminFalsePositives < MAX_CONSECUTIVE_ADMIN_FALSE_POSITIVES) {
      const cred = readCredentials(currentAccount.configDir);
      if (cred.token) {
        const usage = await checkUsage(cred.token);
        const apiOk = !usage.error;
        const belowThreshold =
          usage.sessionPercent < ADMIN_DISABLE_VERIFY_THRESHOLD &&
          usage.weeklyPercent < ADMIN_DISABLE_VERIFY_THRESHOLD;

        if (apiOk && belowThreshold) {
          consecutiveAdminFalsePositives++;
          console.error(
            `\n[claude-nonstop] Admin-disabled message on "${currentAccount.name}" but usage API ` +
            `reports 5h=${usage.sessionPercent}% 7d=${usage.weeklyPercent}% ` +
            `(threshold ${ADMIN_DISABLE_VERIFY_THRESHOLD}%). Treating as false positive ` +
            `(${consecutiveAdminFalsePositives}/${MAX_CONSECUTIVE_ADMIN_FALSE_POSITIVES}); ` +
            `restarting on same account without swap.`
          );

          // Carry session forward on the same account so work resumes.
          const restartSession = result.sessionId
            ? { sessionId: result.sessionId }
            : findLatestSession(currentAccount.configDir, process.cwd());
          if (restartSession) {
            sessionId = restartSession.sessionId;
            claudeArgs = buildResumeArgs(claudeArgs, sessionId, RATE_LIMIT_CONTINUE_MSG);
          } else {
            sessionId = null;
          }
          continue;
        }
      }
    }

    // Confirmed rate-limit (or admin-disabled with real usage / API error /
    // false-positive cap exhausted): proceed with the normal swap path.
    consecutiveAdminFalsePositives = 0;

    // Rate limit detected — attempt swap
    swapCount++;
    console.error(`\n[claude-nonstop] Rate limit detected on "${currentAccount.name}" (swap ${swapCount}/${maxSwaps})`);

    if (swapCount > maxSwaps) {
      console.error('[claude-nonstop] Maximum swap attempts reached. All accounts may be rate-limited.');
      process.exitCode = 1;
      return;
    }

    // Find the session to migrate
    const cwd = process.cwd();
    const session = result.sessionId
      ? { sessionId: result.sessionId }
      : findLatestSession(currentAccount.configDir, cwd);

    if (!session) {
      console.error('[claude-nonstop] Could not find session to migrate. Starting fresh on new account.');
    }

    // Pick the next best account
    const accountsWithTokens = allAccounts.map(a => ({
      ...a,
      token: readCredentials(a.configDir).token,
    })).filter(a => a.token);

    let accountsWithUsage = await checkAllUsage(accountsWithTokens);
    const hasPriorities = accountsWithUsage.some(a => a.priority != null);
    let best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities });

    // If best candidate is near-exhausted, sleep until earliest reset instead of thrashing.
    // Include all accounts (even current) when finding reset times — after sleeping,
    // any account may have recovered, including the one that just hit the limit.
    //
    // TODO: For remote mode, consider an event-driven approach instead of blocking sleep:
    //   1. Notify Slack and save session state to disk
    //   2. Exit the runner cleanly
    //   3. Slack bot schedules a re-launch at the reset time (or user sends !resume)
    // This would free the tmux pane instead of holding it for hours.
    if (best && effectiveUtilization(best.account.usage) >= EXHAUSTION_THRESHOLD) {
      const sleepMs = findEarliestReset(accountsWithUsage);
      if (sleepMs > 0) {
        const clampedMs = Math.min(sleepMs, MAX_SLEEP_MS);
        const resetDate = new Date(Date.now() + clampedMs);
        console.error(`[claude-nonstop] All accounts near limit. Sleeping until ${resetDate.toLocaleTimeString()} (${formatDuration(clampedMs)})...`);

        if (remoteAccess) {
          spawnHookNotify('sleep-until-reset', {
            session_id: sessionId || null,
            cwd: process.cwd(),
            current_account: currentAccount.name,
            sleep_ms: clampedMs,
            reset_at: resetDate.toISOString(),
          });
        }

        const { interrupted } = await sleep(clampedMs);
        if (interrupted) {
          console.error('\n[claude-nonstop] Sleep interrupted by signal. Exiting.');
          process.exitCode = 130;
          return;
        }

        console.error('[claude-nonstop] Sleep complete. Re-checking account usage...');

        // Re-fetch usage after sleeping — any account may have recovered,
        // including the current one, so don't exclude it from the pick.
        const refreshedTokens = allAccounts.map(a => ({
          ...a,
          token: readCredentials(a.configDir).token,
        })).filter(a => a.token);
        accountsWithUsage = await checkAllUsage(refreshedTokens);
        best = pickBestAccount(accountsWithUsage, undefined, { usePriority: hasPriorities });

        if (remoteAccess) {
          spawnHookNotify('sleep-wake', {
            session_id: sessionId || null,
            cwd: process.cwd(),
            current_account: currentAccount.name,
            best_account: best?.account?.name || null,
          });
        }

        // Sleep-then-swap doesn't count against the swap budget — the sleep
        // itself is the mechanism to avoid thrashing, so this is a "free" swap.
        swapCount--;
      }
    }

    // If no accounts available, check if auth errors are the cause and attempt re-auth
    if (!best && !remoteAccess) {
      const authErrors = accountsWithUsage.filter(a =>
        a.name !== currentAccount.name && a.usage?.error === 'HTTP 401'
      );
      if (authErrors.length > 0) {
        console.error('[claude-nonstop] Some accounts have expired tokens. Attempting re-auth...');
        const refreshed = await reauthExpiredAccounts(authErrors);
        if (refreshed.length > 0) {
          // Re-read credentials and re-check usage
          const updatedAccounts = allAccounts.map(a => ({
            ...a,
            token: readCredentials(a.configDir).token,
          })).filter(a => a.token);
          accountsWithUsage = await checkAllUsage(updatedAccounts);
          best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities });
        }
      }
    }

    if (!best) {
      console.error('[claude-nonstop] No alternative accounts available.');
      process.exitCode = 1;
      return;
    }

    const nextAccount = best.account;
    console.error(`[claude-nonstop] Switching to "${nextAccount.name}" (${best.reason})`);

    // Notify Slack about account switch (fire-and-forget)
    if (remoteAccess) {
      spawnHookNotify('account-switch', {
        session_id: sessionId || null,
        cwd: process.cwd(),
        from_account: currentAccount.name,
        to_account: nextAccount.name,
        reason: best.reason,
        swap_count: swapCount,
        max_swaps: maxSwaps,
      });
    }

    // Migrate session if we have one
    if (session) {
      const migration = migrateSession(
        currentAccount.configDir,
        nextAccount.configDir,
        cwd,
        session.sessionId
      );

      if (migration.success) {
        sessionId = session.sessionId;
        console.error(`[claude-nonstop] Session ${sessionId} migrated successfully`);
      } else {
        console.error(`[claude-nonstop] Session migration failed: ${migration.error}`);
        console.error('[claude-nonstop] Starting fresh session on new account');
        sessionId = null;
      }
    } else {
      sessionId = null;
    }

    // Update args for resume if we have a session — include continuation
    // message so Claude picks up immediately instead of waiting for input
    if (sessionId) {
      claudeArgs = buildResumeArgs(claudeArgs, sessionId, RATE_LIMIT_CONTINUE_MSG);
    }

    currentAccount = nextAccount;
  }
}

/**
 * Run Claude once, monitoring for rate limits.
 *
 * @returns {Promise<{ exitCode: number|null, rateLimitDetected: boolean, resetTime: string|null, sessionId: string|null }>}
 */
function runOnce(claudeArgs, account, existingSessionId, options = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: account.configDir,
      FORCE_COLOR: '1',
    };

    // Strip CLAUDECODE so spawned claude works from inside a Claude Code session
    delete env.CLAUDECODE;

    if (options.remoteAccess) {
      env.CLAUDE_REMOTE_ACCESS = 'true';
    }

    const child = pty.spawn('claude', claudeArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env,
    });

    // Resize PTY when the real terminal resizes
    const onResize = () => {
      try { child.resize(process.stdout.columns, process.stdout.rows); } catch {}
    };
    process.stdout.on('resize', onResize);

    // Forward stdin to the PTY (resume in case it was paused by a previous runOnce)
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onStdinData = (data) => child.write(data);
    process.stdin.on('data', onStdinData);
    process.stdin.on('error', () => {});

    let rateLimitDetected = false;
    let resetTime = null;
    let detectionKind = null;
    let killTriggered = false;

    // Gated detector — suppresses false positives from session-resume replay.
    // See createRateLimitDetector for gate logic (marker A + timeout B).
    const detector = createRateLimitDetector();
    const graceTimer = setTimeout(() => {
      detector.fireTimeout();
    }, SPAWN_GRACE_MS);

    child.onData((data) => {
      process.stdout.write(data);

      const result = detector.feed(data);
      if (result && !killTriggered) {
        killTriggered = true;
        rateLimitDetected = true;
        resetTime = result.resetTime;
        detectionKind = result.kind;
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, KILL_ESCALATION_DELAY);
      }
    });

    // Forward signals to child
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const signalHandlers = {};
    let cleaned = false;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;

      for (const sig of signals) {
        process.removeListener(sig, signalHandlers[sig]);
      }

      process.stdin.removeListener('data', onStdinData);
      process.stdin.pause();
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdout.removeListener('resize', onResize);
    }

    for (const sig of signals) {
      const handler = () => {
        if (!rateLimitDetected) {
          try { child.kill(sig); } catch {}
        }
      };
      signalHandlers[sig] = handler;
      process.on(sig, handler);
    }

    // Single onExit handler: cleanup + resolve
    child.onExit(({ exitCode }) => {
      cleanup();

      resolve({
        exitCode: exitCode ?? null,
        rateLimitDetected,
        resetTime,
        detectionKind,
        sessionId: existingSessionId,
      });
    });
  });
}

/**
 * Extract --resume session ID from claude args if present.
 */
function extractResumeSessionId(args) {
  const idx = args.indexOf('--resume');
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  // Also check -r shorthand
  const idxR = args.indexOf('-r');
  if (idxR !== -1 && idxR + 1 < args.length) {
    return args[idxR + 1];
  }
  return null;
}

/** Known Claude CLI flags that take a value argument. */
const FLAGS_WITH_VALUES = new Set([
  '--append-system-prompt', '--model', '-m',
  '--allowedTools', '--disallowedTools',
]);

/**
 * Build new claude args with --resume flag.
 * Replaces existing --resume if present, otherwise prepends it.
 *
 * When continueMessage is provided (rate-limit swap), strips positional args
 * (the original user prompt and any previous continue message) so Claude
 * receives only the continuation prompt and picks up where it left off.
 */
function buildResumeArgs(originalArgs, sessionId, continueMessage) {
  const args = [...originalArgs];

  // Remove existing --resume or -r flags
  for (const flag of ['--resume', '-r']) {
    const idx = args.indexOf(flag);
    if (idx !== -1) {
      args.splice(idx, 2); // Remove flag and its value
    }
  }

  if (continueMessage) {
    // Strip positional args — keep only flags and their values
    const flagsOnly = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-')) {
        flagsOnly.push(args[i]);
        if (FLAGS_WITH_VALUES.has(args[i]) && i + 1 < args.length) {
          flagsOnly.push(args[++i]);
        }
      }
    }
    flagsOnly.unshift('--resume', sessionId);
    flagsOnly.push(continueMessage);
    return flagsOnly;
  }

  // Prepend --resume
  args.unshift('--resume', sessionId);
  return args;
}

export {
  stripAnsi, extractResumeSessionId, buildResumeArgs, RATE_LIMIT_PATTERN,
  ADMIN_DISABLED_PATTERN, RATE_LIMIT_CONTINUE_MSG, FLAGS_WITH_VALUES,
  findEarliestReset, formatDuration, sleep, deactivateStaleChannels,
  EXHAUSTION_THRESHOLD, MAX_SLEEP_MS,
  ADMIN_DISABLE_VERIFY_THRESHOLD, MAX_CONSECUTIVE_ADMIN_FALSE_POSITIVES,
  createRateLimitDetector,
};
