/**
 * Slack Channel Manager
 * Manages Slack channel lifecycle for per-session mode.
 * Each Claude Code session gets a dedicated Slack channel.
 */

const { WebClient } = require('@slack/web-api');
const path = require('path');
const fs = require('fs');
const { CHANNEL_MAP_PATH, PROGRESS_DIR } = require('./paths.cjs');

const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Convert GitHub-flavored Markdown to Slack mrkdwn.
 * Handles bold, links, headers, and horizontal rules.
 */
function markdownToMrkdwn(text) {
    if (!text) return '';
    return text
        .replace(/\*\*(.+?)\*\*/g, '*$1*')       // **bold** → *bold*
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>') // [text](url) → <url|text>
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')    // ## Header → *Header*
        .replace(/^---+$/gm, '');                  // --- → remove
}

class SlackChannelManager {
    constructor(config = {}) {
        this.client = new WebClient(config.botToken);
        this.inviteUserId = config.inviteUserId || process.env.SLACK_INVITE_USER_ID;
        this.channelPrefix = config.channelPrefix || process.env.SLACK_CHANNEL_PREFIX || 'cn';
        this.channelMapPath = config.channelMapPath || CHANNEL_MAP_PATH;

        // One-time migration from legacy location
        const legacyPath = path.join(__dirname, 'data/channel-map.json');
        if (!fs.existsSync(this.channelMapPath) && fs.existsSync(legacyPath)) {
            try {
                const dir = path.dirname(this.channelMapPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.copyFileSync(legacyPath, this.channelMapPath);
            } catch (err) {
                console.warn('Failed to migrate channel-map.json:', err.message);
            }
        }
    }

    /**
     * Generate a Slack-safe channel name.
     * Slack requires: lowercase, numbers, hyphens, underscores. Max 80 chars.
     */
    _generateChannelName(project, sessionId) {
        const shortId = sessionId.substring(0, 8).toLowerCase();
        const safeProject = project
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        const name = `${this.channelPrefix}-${safeProject}-${shortId}`;
        return name.substring(0, 80);
    }

    _readChannelMap() {
        try {
            if (!fs.existsSync(this.channelMapPath)) {
                return {};
            }
            const raw = fs.readFileSync(this.channelMapPath, 'utf8');
            if (!raw.trim()) return {};
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return {};
            }
            return parsed;
        } catch (error) {
            console.error('Error reading channel-map.json:', error.message);
            return {};
        }
    }

    _pruneStaleEntries(map) {
        const now = Date.now();
        const pruned = {};
        for (const [sessionId, entry] of Object.entries(map)) {
            if (entry.active) {
                pruned[sessionId] = entry;
                continue;
            }
            const archivedAt = entry.archivedAt ? new Date(entry.archivedAt).getTime() : 0;
            const createdAt = entry.createdAt ? new Date(entry.createdAt).getTime() : 0;
            const refTime = archivedAt || createdAt;
            if (refTime && (now - refTime) < PRUNE_AGE_MS) {
                pruned[sessionId] = entry;
            }
        }
        return pruned;
    }

    _writeChannelMap(map) {
        try {
            const prunedMap = this._pruneStaleEntries(map);
            const dir = path.dirname(this.channelMapPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Atomic write: temp file + rename
            const content = JSON.stringify(prunedMap, null, 2);
            const tmpFile = path.join(dir, `.channel-map.${process.pid}.${Date.now()}.tmp`);
            fs.writeFileSync(tmpFile, content, { mode: 0o600 });
            fs.renameSync(tmpFile, this.channelMapPath);
        } catch (error) {
            console.error('Error writing channel-map.json:', error.message);
        }
    }

    getChannelMapping(sessionId) {
        const map = this._readChannelMap();
        const entry = map[sessionId];
        if (entry && entry.active) {
            return entry;
        }
        return null;
    }

    /**
     * Look up an active session by its cwd (working directory).
     * Used as fallback when sessionId is not known (fresh sessions).
     */
    getSessionByCwd(cwd) {
        const map = this._readChannelMap();
        for (const [sessionId, entry] of Object.entries(map)) {
            if (entry.cwd === cwd && entry.active) {
                return { sessionId, ...entry };
            }
        }
        return null;
    }

    getSessionByChannelId(channelId) {
        const map = this._readChannelMap();
        for (const [sessionId, entry] of Object.entries(map)) {
            if (entry.channelId === channelId && entry.active) {
                return { sessionId, ...entry };
            }
        }
        return null;
    }

    async getOrCreateChannel(sessionId, project, cwd, tmuxSession) {
        const existing = this.getChannelMapping(sessionId);
        if (existing) {
            return existing;
        }

        const channelName = this._generateChannelName(project, sessionId);

        let channelId;
        let finalName = channelName;
        try {
            const result = await this.client.conversations.create({
                name: channelName,
                is_private: false
            });
            channelId = result.channel.id;
            finalName = result.channel.name;
        } catch (error) {
            if (error.data?.error === 'name_taken') {
                const suffix = Date.now().toString(36).slice(-4);
                finalName = `${channelName}-${suffix}`.substring(0, 80);
                try {
                    const result = await this.client.conversations.create({
                        name: finalName,
                        is_private: false
                    });
                    channelId = result.channel.id;
                    finalName = result.channel.name;
                } catch (retryError) {
                    console.error('Failed to create channel on retry:', retryError.message);
                    throw retryError;
                }
            } else {
                console.error('Failed to create Slack channel:', error.message);
                throw error;
            }
        }

        try {
            await this.client.conversations.setTopic({
                channel: channelId,
                topic: `Claude Code | Project: ${project} | tmux: ${tmuxSession || 'N/A'}`
            });
        } catch (error) {
            console.warn('Failed to set channel topic:', error.message);
        }

        if (this.inviteUserId) {
            try {
                await this.client.conversations.invite({
                    channel: channelId,
                    users: this.inviteUserId
                });
            } catch (error) {
                if (error.data?.error !== 'already_in_channel') {
                    console.warn('Failed to invite user to channel:', error.message);
                }
            }
        }

        try {
            await this.client.chat.postMessage({
                channel: channelId,

                text: `Session started for *${project}*`,
                blocks: [
                    {
                        type: 'header',
                        text: { type: 'plain_text', text: 'Claude Code Session', emoji: true }
                    },
                    {
                        type: 'section',
                        fields: [
                            { type: 'mrkdwn', text: `*Project:*\n${project}` },
                            { type: 'mrkdwn', text: `*tmux:*\n\`${tmuxSession || 'N/A'}\`` }
                        ]
                    },
                    {
                        type: 'section',
                        text: { type: 'mrkdwn', text: `*Directory:*\n\`${cwd}\`` }
                    },
                    { type: 'divider' },
                    {
                        type: 'context',
                        elements: [
                            { type: 'mrkdwn', text: 'Reply in this channel to send commands to Claude. Type `!help` for available commands.' }
                        ]
                    }
                ]
            });
        } catch (error) {
            console.warn('Failed to post welcome message:', error.message);
        }

        const mapping = {
            channelId,
            channelName: finalName,
            tmuxSession: tmuxSession || null,
            project,
            cwd,
            createdAt: new Date().toISOString(),
            active: true
        };

        const map = this._readChannelMap();
        map[sessionId] = mapping;
        this._writeChannelMap(map);

        console.log(`Created Slack channel #${finalName} for session ${sessionId}`);
        return mapping;
    }

    async postToSessionChannel(sessionId, text, blocks) {
        const mapping = this.getChannelMapping(sessionId);
        if (!mapping) {
            console.warn(`No channel mapping found for session ${sessionId}`);
            return false;
        }

        try {
            if (blocks) {
                await this.client.chat.postMessage({
                    channel: mapping.channelId,
    
                    text,
                    blocks
                });
            } else {
                const MAX_LEN = 39500;
                const chunks = [];
                let remaining = text;
                while (remaining.length > MAX_LEN) {
                    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
                    if (splitAt < MAX_LEN * 0.5) {
                        splitAt = MAX_LEN;
                    }
                    chunks.push(remaining.substring(0, splitAt));
                    remaining = remaining.substring(splitAt).replace(/^\n/, '');
                }
                chunks.push(remaining);

                for (const chunk of chunks) {
                    await this.client.chat.postMessage({
                        channel: mapping.channelId,
        
                        text: chunk
                    });
                }
            }
            return true;
        } catch (error) {
            if (error.data?.error === 'channel_not_found' || error.data?.error === 'is_archived') {
                console.warn(`Channel ${mapping.channelId} not found, removing stale mapping`);
                const map = this._readChannelMap();
                if (map[sessionId]) {
                    map[sessionId].active = false;
                    this._writeChannelMap(map);
                }
                return false;
            }
            console.error('Failed to post to session channel:', error.message);
            return false;
        }
    }

    async setTypingIndicator(channelId, messageTs) {
        // Clear previous typing indicator before setting new one
        const map = this._readChannelMap();
        for (const [, entry] of Object.entries(map)) {
            if (entry.channelId === channelId && entry.active && entry.pendingMessageTs) {
                try {
                    await this.client.reactions.remove({
                        channel: channelId,
                        timestamp: entry.pendingMessageTs,
                        name: 'hourglass_flowing_sand'
                    });
                } catch (error) {
                    if (error.data?.error !== 'no_reaction') {
                        console.warn('Failed to remove previous typing reaction:', error.message);
                    }
                }
                break;
            }
        }

        try {
            await this.client.reactions.add({
                channel: channelId,
                timestamp: messageTs,
                name: 'hourglass_flowing_sand'
            });
        } catch (error) {
            if (error.data?.error !== 'already_reacted') {
                console.warn('Failed to add typing reaction:', error.message);
            }
        }

        for (const [, entry] of Object.entries(map)) {
            if (entry.channelId === channelId && entry.active) {
                entry.pendingMessageTs = messageTs;
                break;
            }
        }
        this._writeChannelMap(map);
    }

    async clearTypingIndicator(sessionId) {
        const map = this._readChannelMap();
        const entry = map[sessionId];
        if (!entry || !entry.pendingMessageTs) {
            return;
        }

        try {
            await this.client.reactions.remove({
                channel: entry.channelId,
                timestamp: entry.pendingMessageTs,
                name: 'hourglass_flowing_sand'
            });
        } catch (error) {
            if (error.data?.error !== 'no_reaction') {
                console.warn('Failed to remove typing reaction:', error.message);
            }
        }

        // Don't clear pendingMessageTs — it's reused for threading progress messages.
        // setTypingIndicator will overwrite it on the next Slack message.
    }

    /**
     * Post or update a progress message in a session's channel.
     * Creates a new message if none exists, otherwise updates it.
     * @returns {boolean} true if successful
     */
    async updateProgressMessage(sessionId, text) {
        const map = this._readChannelMap();
        const entry = map[sessionId];
        if (!entry || !entry.active) return false;

        try {
            if (entry.progressMessageTs) {
                await this.client.chat.update({
                    channel: entry.channelId,
                    ts: entry.progressMessageTs,
                    text
                });
            } else {
                const opts = { channel: entry.channelId, text };
                if (entry.pendingMessageTs) {
                    opts.thread_ts = entry.pendingMessageTs;
                }
                const result = await this.client.chat.postMessage(opts);
                entry.progressMessageTs = result.ts;
                this._writeChannelMap(map);
            }
            return true;
        } catch (error) {
            if (error.data?.error === 'message_not_found') {
                // Message was deleted; post a new one
                try {
                    const opts = { channel: entry.channelId, text };
                    if (entry.pendingMessageTs) {
                        opts.thread_ts = entry.pendingMessageTs;
                    }
                    const result = await this.client.chat.postMessage(opts);
                    entry.progressMessageTs = result.ts;
                    this._writeChannelMap(map);
                    return true;
                } catch { /* fall through */ }
            }
            console.warn('Failed to update progress message:', error.message);
            return false;
        }
    }

    /**
     * Delete the progress Slack message and clean up buffer file.
     */
    async clearProgressMessage(sessionId) {
        const map = this._readChannelMap();
        const entry = map[sessionId];
        if (!entry) return;

        // Delete the Slack message if it exists
        if (entry.progressMessageTs && entry.channelId) {
            try {
                await this.client.chat.delete({
                    channel: entry.channelId,
                    ts: entry.progressMessageTs
                });
            } catch (error) {
                if (error.data?.error !== 'message_not_found') {
                    console.warn('Failed to delete progress message:', error.message);
                }
            }
        }

        // Re-read map after API call to avoid clobbering concurrent writes
        // (e.g. setTypingIndicator setting pendingMessageTs from a new Slack message)
        const freshMap = this._readChannelMap();
        const freshEntry = freshMap[sessionId];
        if (!freshEntry) return;

        delete freshEntry.progressMessageTs;
        this._writeChannelMap(freshMap);

        // Clean up progress buffer file
        const bufPath = path.join(PROGRESS_DIR, `progress-${sessionId}.json`);
        try { fs.unlinkSync(bufPath); } catch {}
    }

    /**
     * Post a thread reply to a specific parent message in a session's channel.
     * @param {string} sessionId
     * @param {string} parentTs - timestamp of the parent message
     * @param {string} text
     * @returns {boolean}
     */
    async postToThread(sessionId, parentTs, text) {
        const mapping = this.getChannelMapping(sessionId);
        if (!mapping) return false;

        try {
            await this.client.chat.postMessage({
                channel: mapping.channelId,

                text,
                thread_ts: parentTs
            });
            return true;
        } catch (error) {
            console.warn('Failed to post thread reply:', error.message);
            return false;
        }
    }

    async archiveChannel(channelId) {
        try {
            await this.client.conversations.archive({ channel: channelId });
        } catch (error) {
            if (error.data?.error !== 'already_archived') {
                console.error('Failed to archive channel:', error.message);
                throw error;
            }
        }

        const map = this._readChannelMap();
        for (const [sessionId, entry] of Object.entries(map)) {
            if (entry.channelId === channelId) {
                map[sessionId].active = false;
                map[sessionId].archivedAt = new Date().toISOString();
                // Clean up progress buffer file
                const bufPath = path.join(PROGRESS_DIR, `progress-${sessionId}.json`);
                try { fs.unlinkSync(bufPath); } catch {}
                break;
            }
        }
        this._writeChannelMap(map);

        console.log(`Archived Slack channel ${channelId}`);
    }
}

module.exports = SlackChannelManager;
module.exports.markdownToMrkdwn = markdownToMrkdwn;
