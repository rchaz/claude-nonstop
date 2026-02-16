#!/usr/bin/env node

/**
 * Start Slack Webhook
 * Runs the Slack bot in Socket Mode to receive and relay commands.
 */

const fs = require('fs');
const { LOG_DIR, LOG_PATH } = require('./paths.cjs');

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const LOG_CHECK_INTERVAL = 60_000;     // 60 s

/**
 * Redirect stdout/stderr to a rotating log file (daemon mode only).
 * Keeps one backup: webhook.log.1.
 */
function setupLogging() {
  if (process.stdout.isTTY) return;

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  }

  const prevPath = LOG_PATH + '.1';

  // Rotate on startup if already over limit
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG_SIZE) {
      fs.renameSync(LOG_PATH, prevPath);
    }
  } catch {}

  let logStream = fs.createWriteStream(LOG_PATH, { flags: 'a', mode: 0o600 });

  const write = (chunk, encoding, callback) => {
    logStream.write(chunk, encoding, callback);
    return true;
  };

  process.stdout.write = write;
  process.stderr.write = write;

  // Periodic rotation check
  const interval = setInterval(() => {
    try {
      if (fs.statSync(LOG_PATH).size > MAX_LOG_SIZE) {
        logStream.end();
        try { fs.renameSync(LOG_PATH, prevPath); } catch {}
        logStream = fs.createWriteStream(LOG_PATH, { flags: 'a', mode: 0o600 });
      }
    } catch {}
  }, LOG_CHECK_INTERVAL);
  interval.unref();
}

setupLogging();

require('./load-env.cjs');

const SlackWebhook = require('./webhook.cjs');

async function main() {
    if (!process.env.SLACK_BOT_TOKEN) {
        console.log('SLACK_BOT_TOKEN is required. Run "claude-nonstop setup" to configure.');
        process.exit(1);
    }

    if (!process.env.SLACK_APP_TOKEN) {
        console.log('SLACK_APP_TOKEN is required for Socket Mode. Run "claude-nonstop setup" to configure.');
        process.exit(1);
    }

    const webhook = new SlackWebhook({
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        allowedUsers: process.env.SLACK_ALLOWED_USERS?.split(',').map(s => s.trim()).filter(Boolean),
    });

    process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await webhook.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await webhook.stop();
        process.exit(0);
    });

    await webhook.start();
}

main().catch(error => {
    console.error('Failed to start Slack webhook:', error.message);
    process.exit(1);
});
