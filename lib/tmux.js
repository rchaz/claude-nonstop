/**
 * tmux session management for --remote-access mode.
 *
 * Handles detecting if we're inside tmux, generating session names,
 * and re-executing the current process inside a new tmux session.
 */

import { execFileSync } from 'child_process';
import { basename } from 'path';
import { createHash } from 'crypto';

/**
 * Check if currently running inside a tmux session.
 * @returns {boolean}
 */
export function isInsideTmux() {
  return !!process.env.TMUX;
}

/**
 * Generate a tmux session name from the current working directory.
 * Uses basename + short hash of full path to avoid collisions when
 * multiple projects share the same directory name.
 * Example: /Users/rc/code/myproject -> "myproject-a1b2c3"
 * @returns {string}
 */
export function generateSessionName() {
  const cwd = process.cwd();
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 6);
  const base = `${basename(cwd)}-${hash}`;
  if (!tmuxSessionExists(base)) return base;
  let counter = 2;
  while (tmuxSessionExists(`${base}-${counter}`)) counter++;
  return `${base}-${counter}`;
}

/**
 * Get the name of the current tmux session (must be called from inside tmux).
 * @returns {string|null} Session name, or null if not inside tmux.
 */
export function getCurrentTmuxSession() {
  try {
    return execFileSync('tmux', ['display-message', '-p', '#S'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if a tmux session with the given name exists.
 * @param {string} name
 * @returns {boolean}
 */
export function tmuxSessionExists(name) {
  try {
    execFileSync('tmux', ['has-session', '-t', name], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-exec the current process inside a new or existing tmux session.
 *
 * If a tmux session with the given name exists, attaches to it.
 * If not, creates a new session running the same command.
 *
 * Uses execSync with stdio: 'inherit' so the terminal stays connected
 * to the tmux session. When the user detaches (Ctrl-B D), execSync
 * returns and we exit cleanly.
 *
 * @param {string} sessionName - The tmux session name
 * @param {string[]} argv - The full process.argv to re-invoke
 */
export function reexecInTmux(sessionName, argv) {
  if (tmuxSessionExists(sessionName)) {
    // Session exists — just attach
    execFileSync('tmux', ['attach-session', '-t', sessionName], {
      stdio: 'inherit',
    });
  } else {
    // Create new session running the same command
    execFileSync('tmux', ['new-session', '-s', sessionName, ...argv], {
      stdio: 'inherit',
    });
  }

  process.exit(0);
}
