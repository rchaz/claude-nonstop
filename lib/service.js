import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isMacOS } from './platform.js';
import { CONFIG_DIR } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const SERVICE_LABEL = 'claude-nonstop-slack';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const LOG_DIR = join(CONFIG_DIR, 'logs');
const LOG_PATH = join(LOG_DIR, 'webhook.log');

/**
 * Generate the launchd plist XML for the webhook service.
 */
function generatePlist() {
  const webhookScript = join(PROJECT_ROOT, 'remote', 'start-webhook.cjs');
  const nodePath = process.execPath;
  const nodeBinDir = dirname(nodePath);

  // Build PATH including the directory containing tmux, which may be in
  // /opt/homebrew/bin (Apple Silicon) or elsewhere not in launchd's default PATH.
  const pathDirs = new Set([nodeBinDir, '/usr/local/bin', '/usr/bin', '/bin']);
  try {
    const tmuxPath = execFileSync('which', ['tmux'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (tmuxPath) pathDirs.add(dirname(tmuxPath));
  } catch {
    // tmux not found — include /opt/homebrew/bin as a common fallback
    pathDirs.add('/opt/homebrew/bin');
  }
  const envPath = [...pathDirs].join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${webhookScript}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${envPath}</string>
    </dict>
</dict>
</plist>
`;
}

/**
 * Install and start the launchd service.
 */
function installService() {
  if (!isMacOS()) {
    throw new Error('Service management is only supported on macOS (launchd)');
  }

  // Ensure log directory exists (user-only permissions)
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  }

  // Ensure LaunchAgents directory exists
  const launchAgentsDir = dirname(PLIST_PATH);
  if (!existsSync(launchAgentsDir)) {
    mkdirSync(launchAgentsDir, { recursive: true });
  }

  const uid = process.getuid();
  const domain = `gui/${uid}`;

  // Bootout first if already loaded (so bootstrap picks up the new plist)
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { stdio: 'pipe' });
  } catch {
    // Ignore — service may not be loaded
  }

  // Write plist (after bootout, before bootstrap) with restrictive permissions
  const plist = generatePlist();
  writeFileSync(PLIST_PATH, plist, { mode: 0o600 });

  // Bootstrap the service (load + start)
  try {
    execFileSync('launchctl', ['bootstrap', domain, PLIST_PATH], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Failed to bootstrap service: ${err.stderr?.toString().trim() || err.message}`);
  }
}

/**
 * Stop and remove the launchd service.
 */
function uninstallService() {
  if (!isMacOS()) {
    throw new Error('Service management is only supported on macOS (launchd)');
  }

  const uid = process.getuid();
  const domain = `gui/${uid}`;

  // Bootout (stop + unload)
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { stdio: 'pipe' });
  } catch {
    // Ignore — service may not be loaded
  }

  // Delete plist
  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
  }
}

/**
 * Restart the launchd service (also refreshes the plist).
 */
function restartService() {
  if (!isMacOS()) {
    throw new Error('Service management is only supported on macOS (launchd)');
  }

  // Full cycle: bootout, write fresh plist, bootstrap
  // This ensures path changes (node upgrade, project move) are picked up
  installService();
}

/**
 * Get service status including PID.
 * Returns { installed, running, pid }.
 */
function getServiceStatus() {
  if (!isMacOS()) {
    return { installed: false, running: false, pid: null };
  }

  const installed = existsSync(PLIST_PATH);
  if (!installed) {
    return { installed: false, running: false, pid: null };
  }

  const uid = process.getuid();
  const domain = `gui/${uid}`;

  try {
    const output = execFileSync('launchctl', ['print', `${domain}/${SERVICE_LABEL}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

    // Parse PID from output (line like "pid = 12345" or "pid = (not running)")
    const pidMatch = output.match(/pid\s*=\s*(\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
    const running = pid !== null;

    return { installed: true, running, pid };
  } catch {
    // Service not loaded
    return { installed: true, running: false, pid: null };
  }
}

/**
 * Check if the service plist is installed.
 */
function isServiceInstalled() {
  return isMacOS() && existsSync(PLIST_PATH);
}

export {
  SERVICE_LABEL,
  PLIST_PATH,
  LOG_PATH,
  LOG_DIR,
  generatePlist,
  installService,
  uninstallService,
  restartService,
  getServiceStatus,
  isServiceInstalled,
};
