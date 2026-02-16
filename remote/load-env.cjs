/**
 * Load .env from ~/.claude-nonstop/.env (preferred) or project root (legacy fallback).
 * Simple parser — no dotenv dependency needed.
 * Existing env vars are NOT overwritten.
 */

const path = require('path');
const fs = require('fs');
const { ENV_PATH } = require('./paths.cjs');

const legacyEnvPath = path.join(__dirname, '..', '.env');

// Prefer new location; fall back to legacy project-root location
let envPath = ENV_PATH;
if (!fs.existsSync(envPath) && fs.existsSync(legacyEnvPath)) {
    envPath = legacyEnvPath;
}

if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}
