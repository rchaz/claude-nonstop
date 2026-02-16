/**
 * Slack Webhook Handler
 * Handles incoming messages from Slack via Socket Mode.
 * Relays messages to Claude Code tmux sessions.
 */

const { App } = require('@slack/bolt');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const SlackChannelManager = require('./channel-manager.cjs');

class SlackWebhook {
    constructor(config = {}) {
        this.config = config;
        this.app = null;
        this._channelManager = null;
    }

    _getChannelManager() {
        if (!this._channelManager) {
            this._channelManager = new SlackChannelManager({
                botToken: this.config.botToken,
                inviteUserId: process.env.SLACK_INVITE_USER_ID,
                channelPrefix: process.env.SLACK_CHANNEL_PREFIX || 'cn'
            });
        }
        return this._channelManager;
    }

    _isUserAllowed(userId) {
        if (!this.config.allowedUsers || this.config.allowedUsers.length === 0) {
            return true;
        }
        return this.config.allowedUsers.includes(userId);
    }

    async start() {
        if (!this.config.botToken || !this.config.appToken) {
            console.error('Slack Bot Token and App Token are required');
            return;
        }

        this.app = new App({
            token: this.config.botToken,
            appToken: this.config.appToken,
            socketMode: true
        });

        // Handle messages in session channels and DMs
        this.app.message(async ({ message, say }) => {
          try {
            console.log('Received message:', message.text);
            if (message.subtype || message.bot_id) return;

            const text = message.text?.trim() || '';
            if (!text) return;

            // Per-session channel handling
            const channelManager = this._getChannelManager();
            const sessionInfo = channelManager.getSessionByChannelId(message.channel);
            if (sessionInfo && sessionInfo.active) {
                if (!this._isUserAllowed(message.user)) {
                    await say(':no_entry: You are not authorized to send commands.');
                    return;
                }

                if (text === '!archive') {
                    await say(':file_folder: Archiving this session channel...');
                    await channelManager.archiveChannel(message.channel);
                    return;
                }

                if (text === '!stop') {
                    if (sessionInfo.tmuxSession) {
                        spawnSync('tmux', ['send-keys', '-t', sessionInfo.tmuxSession, 'C-c']);
                        await say(':stop_sign: Sent interrupt to Claude');
                    } else {
                        await say('No tmux session associated with this channel.');
                    }
                    return;
                }

                if (text === '!status') {
                    if (sessionInfo.tmuxSession) {
                        const result = spawnSync('tmux', ['capture-pane', '-p', '-t', sessionInfo.tmuxSession], {
                            encoding: 'utf8',
                            timeout: 5000,
                        });
                        if (result.error || result.status !== 0) {
                            await say(':warning: Failed to capture terminal — tmux session may have ended');
                        } else {
                            let paneContent = (result.stdout || '').trimEnd();
                            if (paneContent.length > 3900) {
                                paneContent = paneContent.substring(paneContent.length - 3900);
                            }
                            await say('```\n' + paneContent + '\n```');
                        }
                    } else {
                        await say('No tmux session associated with this channel.');
                    }
                    return;
                }

                if (text === '!help') {
                    await say(':information_source: *Available commands:*\n\u2022 `!stop` \u2014 interrupt Claude (Ctrl+C)\n\u2022 `!status` \u2014 show current terminal output\n\u2022 `!archive` \u2014 archive this channel\n\u2022 `!help` \u2014 show this help');
                    return;
                }

                if (sessionInfo.tmuxSession) {
                    await channelManager.setTypingIndicator(message.channel, message.ts);
                    const relayOk = this._executeTmuxCommand(text, { tmuxSession: sessionInfo.tmuxSession });
                    if (!relayOk) {
                        await say(':warning: Failed to relay message \u2014 tmux session may have ended');
                    }
                } else {
                    await say('No tmux session associated with this channel.');
                }
                return;
            }

            // Default tmux session fallback (DMs or dedicated channel)
            const defaultTmuxSession = process.env.DEFAULT_TMUX_SESSION;
            const dedicatedChannel = process.env.SLACK_CHANNEL_ID;
            const isAllowedChannel = message.channel_type === 'im' || message.channel === dedicatedChannel;

            if (defaultTmuxSession && text.length > 0 && isAllowedChannel) {
                if (!this._isUserAllowed(message.user)) {
                    await say(':no_entry: You are not authorized to send commands.');
                    return;
                }

                await say(`:rocket: Sending to tmux session \`${defaultTmuxSession}\`...\n\`${text}\``);
                this._executeTmuxCommand(text, { tmuxSession: defaultTmuxSession });
                return;
            }
          } catch (err) {
            console.error('Message handler error:', err.message);
          }
        });

        // Handle app mentions
        this.app.event('app_mention', async ({ event, say }) => {
          try {
            console.log('Received app_mention:', event.text);
            const text = event.text.replace(/<@[A-Z0-9]+>/gi, '').trim();
            if (!text) return;

            const defaultTmuxSession = process.env.DEFAULT_TMUX_SESSION;
            if (defaultTmuxSession) {
                if (!this._isUserAllowed(event.user)) {
                    await say(':no_entry: You are not authorized to send commands.');
                    return;
                }

                await say(`:rocket: Sending to tmux session \`${defaultTmuxSession}\`...\n\`${text}\``);
                this._executeTmuxCommand(text, { tmuxSession: defaultTmuxSession });
            }
          } catch (err) {
            console.error('App mention handler error:', err.message);
          }
        });

        await this.app.start();
        console.log(':zap: Slack bot is running in Socket Mode');
    }

    /**
     * Send a command to a tmux session.
     * @returns {boolean} true if the text was sent successfully
     */
    _executeTmuxCommand(command, session) {
        const tmuxSession = session.tmuxSession || 'claude';
        const MAX_TMUX_MESSAGE_LENGTH = 4096;

        // Truncate to prevent terminal flooding
        let safeCommand = command;
        if (safeCommand.length > MAX_TMUX_MESSAGE_LENGTH) {
            safeCommand = safeCommand.substring(0, MAX_TMUX_MESSAGE_LENGTH);
        }

        try {
            const baseArgs = ['send-keys', '-t', tmuxSession];

            // Step 1: Send command text (literal mode)
            const textResult = spawnSync('tmux', [...baseArgs, '-l', safeCommand]);
            if (textResult.error || textResult.status !== 0) {
                console.error('tmux send-keys text error:', textResult.error?.message || `exit ${textResult.status}`);
                return false;
            }

            // Step 2: Send Enter key separately (300ms delay for Claude Code to process)
            setTimeout(() => {
                const enterResult = spawnSync('tmux', [...baseArgs, 'Enter']);
                if (enterResult.error) {
                    console.error('tmux send-keys Enter error:', enterResult.error.message);
                }
            }, 300);
            return true;
        } catch (error) {
            console.error('tmux command error:', error.message);
            return false;
        }
    }

    async stop() {
        if (this.app) {
            await this.app.stop();
            console.log('Slack bot stopped');
        }
    }
}

module.exports = SlackWebhook;
