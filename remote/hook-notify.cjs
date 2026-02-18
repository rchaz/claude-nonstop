#!/usr/bin/env node

/**
 * Claude Code Hook Notification Script
 *
 * Called by Claude Code hooks (Stop, SessionStart, PostToolUse) and runner.js (account-switch).
 *
 * Notification types:
 *   session-start      — Create per-session Slack channel (Claude Code hook)
 *   completed          — Post structured completion message (Claude Code hook)
 *   tool-use           — Buffer tool activity, flush to Slack every 10s (Claude Code PostToolUse hook)
 *   waiting-for-input  — Notify when Claude is waiting for user input (Claude Code PreToolUse hook)
 *   account-switch     — Notify about rate limit account switch (runner.js)
 *   sleep-until-reset  — Notify that all accounts are near-exhausted, sleeping until reset (runner.js)
 *   sleep-wake         — Notify that sleep is complete and resuming (runner.js)
 *
 * Environment:
 *   CLAUDE_REMOTE_ACCESS=true  — enables per-session Slack channels
 *   SLACK_BOT_TOKEN            — Slack bot token (xoxb-...)
 *   SLACK_CHANNEL_PREFIX       — channel name prefix (default: 'cn')
 *   SLACK_INVITE_USER_ID       — user to auto-invite to channels
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

require('./load-env.cjs');

const SlackChannelManager = require('./channel-manager.cjs');
const { markdownToMrkdwn } = SlackChannelManager;
const { PROGRESS_DIR } = require('./paths.cjs');

// ─── Progress Buffer Constants ──────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 3_000;
const MAX_BUFFER_EVENTS = 100;

// Tools that pause Claude to wait for user input in the terminal
const WAITING_FOR_INPUT_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion']);

// ─── Stdin Reader ────────────────────────────────────────────────────────────

async function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(null), 2000);

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => {
            clearTimeout(timeout);
            try { resolve(data ? JSON.parse(data) : null); }
            catch { resolve(null); }
        });
        process.stdin.on('error', () => {
            clearTimeout(timeout);
            resolve(null);
        });
    });
}

// ─── Transcript Reader ──────────────────────────────────────────────────────

function getLastAssistantMessage(transcriptPath, maxLength = 0) {
    try {
        if (!fs.existsSync(transcriptPath)) return null;

        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.trim().split('\n');

        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                if (entry.type === 'assistant' && entry.message?.content) {
                    for (const block of entry.message.content) {
                        if (block.type === 'text' && block.text) {
                            const text = block.text.trim();
                            if (text.length > 0) {
                                if (maxLength > 0 && text.length > maxLength) {
                                    return text.substring(0, maxLength) + '...';
                                }
                                return text;
                            }
                        }
                    }
                }
            } catch { continue; }
        }
        return null;
    } catch { return null; }
}

// ─── Current Turn Parser ────────────────────────────────────────────────────

/**
 * Parse the last turn from a Claude Code transcript .jsonl file.
 * Reads backwards from the end to find tool_use entries and the final assistant text.
 * @returns {{ toolUses: Array<{tool: string, file?: string}>, summary: string|null }}
 */
function parseCurrentTurn(transcriptPath) {
    const result = { toolUses: [], summary: null };
    try {
        if (!fs.existsSync(transcriptPath)) return result;

        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.trim().split('\n');

        // Walk backwards collecting entries from the last assistant turn
        let foundAssistant = false;
        for (let i = lines.length - 1; i >= 0; i--) {
            let entry;
            try { entry = JSON.parse(lines[i]); } catch { continue; }

            if (entry.type === 'user') break; // Stop at the last user message

            if (entry.type === 'assistant' && entry.message?.content) {
                foundAssistant = true;
                for (const block of entry.message.content) {
                    if (block.type === 'tool_use') {
                        const toolUse = { tool: block.name };
                        // Extract file path from common input patterns
                        const input = block.input || {};
                        if (input.file_path) toolUse.file = input.file_path;
                        else if (input.path) toolUse.file = input.path;
                        else if (input.pattern) toolUse.file = input.pattern;
                        else if (input.command) toolUse.file = input.command.substring(0, 80);
                        result.toolUses.push(toolUse);
                    }
                    if (block.type === 'text' && block.text && !result.summary) {
                        result.summary = block.text.trim();
                    }
                }
            }
        }

        // If we didn't find structured data, fall back to getLastAssistantMessage
        if (!result.summary && !foundAssistant) {
            result.summary = getLastAssistantMessage(transcriptPath);
        }
    } catch { /* return partial result */ }
    return result;
}

// ─── Transcript Path Resolution ────────────────────────────────────────────

/**
 * Derive the transcript .jsonl path from CLAUDE_CONFIG_DIR, session ID, and CWD.
 * Claude Code stores sessions at: <configDir>/projects/<cwdHash>/<sessionId>.jsonl
 * where cwdHash is the absolute CWD with '/' replaced by '-'.
 *
 * @param {string} sessionId
 * @param {string} cwd
 * @returns {string|null} Path to the transcript file, or null if not found
 */
function findTranscriptPath(sessionId, cwd) {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (!configDir || !sessionId || !cwd) return null;

    const expandedConfigDir = configDir.startsWith('~')
        ? configDir.replace(/^~/, require('os').homedir())
        : configDir;
    const cwdHash = cwd.replace(/\//g, '-');
    const transcriptPath = path.join(expandedConfigDir, 'projects', cwdHash, `${sessionId}.jsonl`);

    try {
        if (fs.existsSync(transcriptPath)) return transcriptPath;
    } catch { /* fall through */ }
    return null;
}

// ─── tmux Detection ─────────────────────────────────────────────────────────

function detectTmuxSession() {
    try {
        return execFileSync('tmux', ['display-message', '-p', '#S'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch { return null; }
}

// ─── Per-Session Mode Check ─────────────────────────────────────────────────

function isPerSessionMode() {
    return process.env.CLAUDE_REMOTE_ACCESS === 'true' &&
           !!process.env.SLACK_BOT_TOKEN;
}

function createChannelManager() {
    return new SlackChannelManager({
        botToken: process.env.SLACK_BOT_TOKEN,
        inviteUserId: process.env.SLACK_INVITE_USER_ID,
        channelPrefix: process.env.SLACK_CHANNEL_PREFIX || 'cn'
    });
}

// ─── Progress Buffer Helpers ────────────────────────────────────────────────

/**
 * Extract a human-readable detail string from tool_input.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string|null}
 */
function extractToolDetail(toolName, toolInput) {
    if (!toolInput || typeof toolInput !== 'object') return null;
    if (toolInput.file_path) return toolInput.file_path;
    if (toolInput.command) return toolInput.command.substring(0, 120);
    if (toolInput.pattern) return toolInput.pattern;
    if (toolInput.query) return toolInput.query.substring(0, 120);
    if (toolInput.path) return toolInput.path;
    if (toolInput.url) return toolInput.url.substring(0, 120);
    if (toolInput.prompt) return toolInput.prompt.substring(0, 80);
    return null;
}

function progressBufferPath(sessionId) {
    return path.join(PROGRESS_DIR, `progress-${sessionId}.json`);
}

function readProgressBuffer(bufPath) {
    try {
        if (!fs.existsSync(bufPath)) return { events: [], lastFlushTs: 0 };
        const raw = fs.readFileSync(bufPath, 'utf8');
        if (!raw.trim()) return { events: [], lastFlushTs: Date.now() };
        return JSON.parse(raw);
    } catch {
        return { events: [], lastFlushTs: Date.now() };
    }
}

function writeProgressBuffer(bufPath, buf) {
    const dir = path.dirname(bufPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = path.join(dir, `.progress-${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpFile, JSON.stringify(buf), { mode: 0o600 });
    fs.renameSync(tmpFile, bufPath);
}

function appendToProgressBuffer(bufPath, event) {
    const buf = readProgressBuffer(bufPath);
    buf.events.push(event);
    if (buf.events.length > MAX_BUFFER_EVENTS) {
        buf.events = buf.events.slice(-MAX_BUFFER_EVENTS);
    }
    writeProgressBuffer(bufPath, buf);
    return buf;
}

/**
 * Format buffered tool events into a Slack progress message.
 * @param {Array<{type: string, detail: string|null, ts: number}>} events
 * @returns {string}
 */
function formatProgressMessage(events) {
    if (!events || events.length === 0) return ':hourglass_flowing_sand: Working...';

    // Deduplicate consecutive same-type events, keep last 8
    const deduped = [];
    for (const e of events) {
        const prev = deduped[deduped.length - 1];
        if (prev && prev.type === e.type && prev.detail === e.detail) continue;
        deduped.push(e);
    }
    const recent = deduped.slice(-8);

    const lines = recent.map(e => {
        const detail = e.detail ? ` \`${e.detail}\`` : '';
        return `\u2022 ${e.type}${detail}`;
    });
    return `:hourglass_flowing_sand: Working...\n${lines.join('\n')}`;
}

/**
 * Format a notification for tools that pause Claude to wait for user input.
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string|null} [transcriptContent] - Last assistant message from transcript (used for plan content)
 * @returns {string}
 */
function formatWaitingMessage(toolName, toolInput, transcriptContent) {
    if (toolName === 'ExitPlanMode') {
        if (transcriptContent) {
            const mrkdwn = markdownToMrkdwn(transcriptContent);
            const MAX_PLAN_LENGTH = 39000;
            const truncated = mrkdwn.length > MAX_PLAN_LENGTH
                ? mrkdwn.substring(0, MAX_PLAN_LENGTH) + '...'
                : mrkdwn;
            return `:clipboard: *Plan ready \u2014 waiting for approval*\n\n${truncated}`;
        }
        return ':clipboard: Plan ready \u2014 waiting for approval in terminal. Use `!status` to view.';
    }
    if (toolName === 'AskUserQuestion') {
        const questions = toolInput?.questions;
        if (questions && questions.length > 0 && questions[0].question) {
            const q = questions[0].question;
            const truncated = q.length > 200 ? q.substring(0, 200) + '...' : q;
            return `:question: Claude is asking: "${truncated}"\nRespond in terminal or use \`!status\` to view.`;
        }
        return ':question: Claude is asking a question \u2014 respond in terminal or use `!status` to view.';
    }
    return ':hourglass: Waiting for input in terminal. Use `!status` to view.';
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const notificationType = process.argv[2] || 'completed';
    const hookContext = await readStdin();

    const currentDir = hookContext?.cwd || process.cwd();
    const projectName = path.basename(currentDir);
    const sessionId = hookContext?.session_id;

    // Handle session-start: reuse existing channel or create new one
    if (notificationType === 'session-start') {
        if (isPerSessionMode() && sessionId) {
            const manager = createChannelManager();
            const tmuxSession = detectTmuxSession();

            // Reuse existing channel if one is already active for this tmux session
            const reused = manager.reuseChannelForTmuxSession(sessionId, tmuxSession);
            if (reused) {
                await manager.postToSessionChannel(sessionId, ':arrows_counterclockwise: New conversation started');
                console.log(`Reusing Slack channel #${reused.channelName} for session ${sessionId}`);
            } else {
                await manager.getOrCreateChannel(sessionId, projectName, currentDir, tmuxSession);
                console.log(`Per-session Slack channel created for ${projectName} (session: ${sessionId})`);
            }
        }
        return;
    }

    // Handle waiting-for-input events from PreToolUse hook (ExitPlanMode, AskUserQuestion)
    // PreToolUse fires BEFORE the tool runs, i.e. when Claude presents the plan or question.
    // PostToolUse fires AFTER the user responds — too late for notification.
    if (notificationType === 'waiting-for-input') {
        if (!isPerSessionMode() || !sessionId) return;

        const toolName = hookContext?.tool_name;
        const toolInput = hookContext?.tool_input;
        if (!toolName || !WAITING_FOR_INPUT_TOOLS.has(toolName)) return;

        const manager = createChannelManager();
        await manager.clearProgressMessage(sessionId);

        // For ExitPlanMode, read the plan content from the transcript
        let transcriptContent = null;
        if (toolName === 'ExitPlanMode') {
            const transcriptPath = hookContext?.transcript_path
                || findTranscriptPath(sessionId, currentDir);
            if (transcriptPath) {
                transcriptContent = getLastAssistantMessage(transcriptPath);
            }
        }

        const text = formatWaitingMessage(toolName, toolInput, transcriptContent);
        await manager.postToSessionChannel(sessionId, text);
        return;
    }

    // Handle tool-use events from PostToolUse hook (buffered, flush every 3s)
    if (notificationType === 'tool-use') {
        if (!isPerSessionMode() || !sessionId) return;

        const toolName = hookContext?.tool_name;
        const toolInput = hookContext?.tool_input;
        if (!toolName) return;

        const detail = extractToolDetail(toolName, toolInput);
        const event = { type: toolName, detail: detail ? detail.substring(0, 120) : null, ts: Date.now() };

        const bufPath = progressBufferPath(sessionId);
        const buf = appendToProgressBuffer(bufPath, event);

        // Flush to Slack if enough time has elapsed
        const now = Date.now();
        if (now - (buf.lastFlushTs || 0) >= FLUSH_INTERVAL_MS) {
            const text = formatProgressMessage(buf.events);
            const manager = createChannelManager();
            await manager.updateProgressMessage(sessionId, text);
            buf.events = [];
            buf.lastFlushTs = now;
            writeProgressBuffer(bufPath, buf);
        }
        return;
    }

    // Handle sleep-until-reset notifications (spawned by runner.js)
    if (notificationType === 'sleep-until-reset') {
        if (!isPerSessionMode()) return;

        const manager = createChannelManager();
        const resolvedId = sessionId || manager.getSessionByCwd(currentDir)?.sessionId;
        if (!resolvedId) return;

        const { current_account, sleep_ms, reset_at } = hookContext || {};
        const hours = Math.floor((sleep_ms || 0) / (1000 * 60 * 60));
        const minutes = Math.floor(((sleep_ms || 0) % (1000 * 60 * 60)) / (1000 * 60));
        const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        const text = `:zzz: All accounts near rate limit. Sleeping for ${duration} (until reset).\nCurrent account: "${current_account}"`;
        await manager.postToSessionChannel(resolvedId, text);
        return;
    }

    // Handle sleep-wake notifications (spawned by runner.js)
    if (notificationType === 'sleep-wake') {
        if (!isPerSessionMode()) return;

        const manager = createChannelManager();
        const resolvedId = sessionId || manager.getSessionByCwd(currentDir)?.sessionId;
        if (!resolvedId) return;

        const { best_account } = hookContext || {};
        const text = best_account
            ? `:sunrise: Woke up! Switching to "${best_account}".`
            : ':sunrise: Woke up! Re-checking accounts...';
        await manager.postToSessionChannel(resolvedId, text);
        return;
    }

    // Handle account-switch notifications (spawned by runner.js)
    if (notificationType === 'account-switch') {
        if (!isPerSessionMode()) return;

        // Resolve sessionId: prefer explicit, fall back to CWD lookup
        const manager = createChannelManager();
        const resolvedId = sessionId || manager.getSessionByCwd(currentDir)?.sessionId;
        if (!resolvedId) return;

        const { from_account, to_account, reason, swap_count, max_swaps } = hookContext || {};
        const text = `:arrows_counterclockwise: Rate limited on "${from_account}", switching to "${to_account}" (swap ${swap_count}/${max_swaps})${reason ? ` \u2014 ${reason}` : ''}`;
        await manager.postToSessionChannel(resolvedId, text);
        return;
    }

    // Post structured completion to per-session Slack channel
    if (isPerSessionMode() && sessionId) {
        const manager = createChannelManager();
        await manager.clearTypingIndicator(sessionId);
        await manager.clearProgressMessage(sessionId);

        const transcriptPath = hookContext?.transcript_path;
        const turn = transcriptPath ? parseCurrentTurn(transcriptPath) : { toolUses: [], summary: null };
        const summary = turn.summary
            ? markdownToMrkdwn(turn.summary)
            : null;

        // Post the assistant's response as a plain message (no Block Kit chrome)
        const messageText = summary || '_No response_';
        const truncatedMessage = messageText.length > 39500
            ? messageText.substring(0, 39500) + '...'
            : messageText;
        const posted = await manager.postToSessionChannel(sessionId, truncatedMessage);

        // If message was truncated, post the full text as a thread reply
        if (posted && messageText.length > 39500 && transcriptPath) {
            const fullMessage = getLastAssistantMessage(transcriptPath);
            if (fullMessage) {
                const threadMessage = markdownToMrkdwn(fullMessage);
                const mapping = manager.getChannelMapping(sessionId);
                if (mapping) {
                    try {
                        const historyResult = await manager.client.conversations.history({
                            channel: mapping.channelId,
                            limit: 1
                        });
                        const latestTs = historyResult.messages?.[0]?.ts;
                        if (latestTs) {
                            const MAX_THREAD = 39500;
                            const truncatedThread = threadMessage.length > MAX_THREAD
                                ? threadMessage.substring(0, MAX_THREAD) + '...'
                                : threadMessage;
                            await manager.postToThread(sessionId, latestTs, truncatedThread);
                        }
                    } catch (err) {
                        console.warn('Failed to post thread reply:', err.message);
                    }
                }
            }
        }

        if (!posted) {
            console.warn('Failed to post to session channel');
        }
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('Hook notification error:', error.message);
        process.exit(1);
    });
}

module.exports = {
    getLastAssistantMessage, parseCurrentTurn, isPerSessionMode, readStdin, markdownToMrkdwn,
    extractToolDetail, formatProgressMessage, formatWaitingMessage, findTranscriptPath,
    // Buffer helpers exported for testing
    readProgressBuffer, writeProgressBuffer, appendToProgressBuffer, progressBufferPath,
    FLUSH_INTERVAL_MS, WAITING_FOR_INPUT_TOOLS,
};
