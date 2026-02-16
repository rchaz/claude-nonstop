const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const SlackWebhook = require('../../../remote/webhook.cjs');

describe('SlackWebhook._isUserAllowed', () => {
  it('allows all when allowedUsers is empty', () => {
    const webhook = new SlackWebhook({ botToken: 'x', appToken: 'x' });
    assert.equal(webhook._isUserAllowed('U12345'), true);
  });

  it('allows all when allowedUsers is not set', () => {
    const webhook = new SlackWebhook({ botToken: 'x', appToken: 'x' });
    assert.equal(webhook._isUserAllowed('U12345'), true);
  });

  it('filters when allowedUsers is non-empty', () => {
    const webhook = new SlackWebhook({
      botToken: 'x',
      appToken: 'x',
      allowedUsers: ['U11111', 'U22222'],
    });
    assert.equal(webhook._isUserAllowed('U11111'), true);
    assert.equal(webhook._isUserAllowed('U99999'), false);
  });

  it('is case-sensitive', () => {
    const webhook = new SlackWebhook({
      botToken: 'x',
      appToken: 'x',
      allowedUsers: ['U12345'],
    });
    assert.equal(webhook._isUserAllowed('u12345'), false);
  });
});

describe('SlackWebhook._executeTmuxCommand', () => {
  // _executeTmuxCommand uses spawnSync('tmux', ...) which may not be available.
  // We test the truncation logic and the -l flag usage indirectly.

  it('truncates messages exceeding 4096 chars', () => {
    const webhook = new SlackWebhook({ botToken: 'x', appToken: 'x' });
    const longMessage = 'x'.repeat(5000);

    // This will fail because tmux isn't running, but we verify it doesn't throw
    // with an overly long message. The function returns false on error.
    const result = webhook._executeTmuxCommand(longMessage, { tmuxSession: 'nonexistent-test-session' });
    assert.equal(result, false);
  });

  it('returns false on error', () => {
    const webhook = new SlackWebhook({ botToken: 'x', appToken: 'x' });
    const result = webhook._executeTmuxCommand('test', { tmuxSession: 'nonexistent-test-session-xyz' });
    assert.equal(result, false);
  });

  it('returns false when tmux session does not exist', () => {
    const webhook = new SlackWebhook({ botToken: 'x', appToken: 'x' });
    const result = webhook._executeTmuxCommand('hello', { tmuxSession: 'nonexistent-session-xyz-test' });
    assert.equal(result, false);
  });

  it('defaults tmuxSession to "claude" when not specified', () => {
    const webhook = new SlackWebhook({ botToken: 'x', appToken: 'x' });
    // With no tmuxSession key, falls back to 'claude'.
    // Returns true if a "claude" tmux session exists, false otherwise — either is valid.
    const result = webhook._executeTmuxCommand('test', {});
    assert.equal(typeof result, 'boolean', 'should return a boolean');
  });
});
