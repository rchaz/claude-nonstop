#!/usr/bin/env node

/**
 * postinstall script — restarts the webhook launchd service after npm install.
 *
 * Self-contained: no imports from lib/ (runs before the project is fully set up).
 * Silently exits on any error (must never break npm install).
 */

import { platform, homedir } from 'os';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

try {
  // Only macOS has launchd
  if (platform() !== 'darwin') process.exit(0);

  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'claude-nonstop-slack.plist');

  // No plist = fresh install, nothing to restart
  if (!existsSync(plistPath)) process.exit(0);

  const uid = process.getuid();
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/claude-nonstop-slack`;

  try {
    execFileSync('launchctl', ['kickstart', '-k', serviceTarget], { stdio: 'pipe' });
  } catch {
    // Kickstart failed — try bootstrap in case service was unloaded
    try {
      execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' });
    } catch {
      // Ignore — service may already be loaded
    }
  }
} catch {
  // Never fail npm install
}
