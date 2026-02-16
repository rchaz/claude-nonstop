const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createMockSlackClient } = require('../../helpers/mock-slack.cjs');
const { createTempDir, removeTempDir } = require('../../helpers/temp-dir.cjs');

// Import markdownToMrkdwn from channel-manager
const SlackChannelManager = require('../../../remote/channel-manager.cjs');
const { markdownToMrkdwn } = SlackChannelManager;

describe('markdownToMrkdwn', () => {
  it('converts **bold** to *bold*', () => {
    assert.equal(markdownToMrkdwn('**hello**'), '*hello*');
  });

  it('converts markdown links to Slack format', () => {
    assert.equal(markdownToMrkdwn('[click](https://example.com)'), '<https://example.com|click>');
  });

  it('converts headers to bold', () => {
    assert.equal(markdownToMrkdwn('## My Header'), '*My Header*');
  });

  it('removes horizontal rules', () => {
    assert.equal(markdownToMrkdwn('---'), '');
  });

  it('handles empty input', () => {
    assert.equal(markdownToMrkdwn(''), '');
  });

  it('handles null input', () => {
    assert.equal(markdownToMrkdwn(null), '');
  });

  it('handles mixed content', () => {
    const input = '## Title\n**bold** and [link](https://x.com)\n---';
    const result = markdownToMrkdwn(input);
    assert.ok(result.includes('*Title*'));
    assert.ok(result.includes('*bold*'));
    assert.ok(result.includes('<https://x.com|link>'));
  });

  it('passes plain text through', () => {
    assert.equal(markdownToMrkdwn('plain text'), 'plain text');
  });
});

describe('SlackChannelManager._generateChannelName', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(tempDir, 'data', 'channel-map.json'),
      channelPrefix: 'cn',
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('generates lowercase channel name', () => {
    const name = manager._generateChannelName('MyProject', 'abcdef12-3456');
    assert.match(name, /^cn-myproject-abcdef12$/);
  });

  it('sanitizes special characters', () => {
    const name = manager._generateChannelName('my project!@#', 'abcdef12-3456');
    assert.match(name, /^cn-my-project-abcdef12$/);
  });

  it('truncates to 80 chars', () => {
    const longProject = 'a'.repeat(100);
    const name = manager._generateChannelName(longProject, 'abcdef12-3456');
    assert.ok(name.length <= 80);
  });

  it('removes leading/trailing hyphens from project', () => {
    const name = manager._generateChannelName('-proj-', 'abcdef12-3456');
    assert.match(name, /^cn-proj-abcdef12$/);
  });

  it('collapses multiple hyphens', () => {
    const name = manager._generateChannelName('a--b', 'abcdef12-3456');
    assert.match(name, /^cn-a-b-abcdef12$/);
  });
});

describe('SlackChannelManager._readChannelMap', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('returns {} for missing file', () => {
    assert.deepEqual(manager._readChannelMap(), {});
  });

  it('returns {} for corrupt JSON', () => {
    fs.writeFileSync(manager.channelMapPath, '{invalid!}');
    assert.deepEqual(manager._readChannelMap(), {});
  });

  it('returns {} for empty file', () => {
    fs.writeFileSync(manager.channelMapPath, '');
    assert.deepEqual(manager._readChannelMap(), {});
  });

  it('returns {} for JSON array', () => {
    fs.writeFileSync(manager.channelMapPath, '[]');
    assert.deepEqual(manager._readChannelMap(), {});
  });

  it('reads valid channel map', () => {
    const data = { 'sess-1': { channelId: 'C001', active: true } };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));
    const result = manager._readChannelMap();
    assert.equal(result['sess-1'].channelId, 'C001');
  });
});

describe('SlackChannelManager._writeChannelMap', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('writes atomically (no .tmp files left)', () => {
    manager._writeChannelMap({ 'sess-1': { active: true, createdAt: new Date().toISOString() } });
    const files = fs.readdirSync(path.dirname(manager.channelMapPath));
    assert.ok(!files.some(f => f.endsWith('.tmp')));
    assert.ok(files.includes('channel-map.json'));
  });

  it('prunes on write', () => {
    const map = {
      'active': { active: true, createdAt: new Date().toISOString() },
      'stale': { active: false, archivedAt: '2020-01-01T00:00:00.000Z' },
    };
    manager._writeChannelMap(map);
    const result = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.ok(result['active']);
    assert.ok(!result['stale']);
  });
});

describe('SlackChannelManager._pruneStaleEntries', () => {
  let manager;
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(tempDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('keeps active entries', () => {
    const map = { 'sess': { active: true } };
    const result = manager._pruneStaleEntries(map);
    assert.ok(result['sess']);
  });

  it('keeps recent inactive entries', () => {
    const map = {
      'recent': {
        active: false,
        archivedAt: new Date().toISOString(),
      },
    };
    const result = manager._pruneStaleEntries(map);
    assert.ok(result['recent']);
  });

  it('removes stale entries older than 7 days', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const map = {
      'stale': {
        active: false,
        archivedAt: eightDaysAgo,
      },
    };
    const result = manager._pruneStaleEntries(map);
    assert.ok(!result['stale']);
  });
});

describe('SlackChannelManager.getChannelMapping', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('returns active mapping', () => {
    const data = { 'sess-1': { channelId: 'C001', active: true } };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = manager.getChannelMapping('sess-1');
    assert.equal(result.channelId, 'C001');
  });

  it('returns null for inactive mapping', () => {
    const data = { 'sess-1': { channelId: 'C001', active: false } };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    assert.equal(manager.getChannelMapping('sess-1'), null);
  });

  it('returns null for missing session', () => {
    fs.writeFileSync(manager.channelMapPath, '{}');
    assert.equal(manager.getChannelMapping('nonexistent'), null);
  });
});

describe('SlackChannelManager.getSessionByCwd', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('finds session by cwd', () => {
    const data = {
      'sess-1': { channelId: 'C001', cwd: '/tmp/myproject', active: true },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = manager.getSessionByCwd('/tmp/myproject');
    assert.equal(result.sessionId, 'sess-1');
  });

  it('returns null for inactive session', () => {
    const data = {
      'sess-1': { channelId: 'C001', cwd: '/tmp/project', active: false },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    assert.equal(manager.getSessionByCwd('/tmp/project'), null);
  });
});

describe('SlackChannelManager.getSessionByChannelId', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('finds session by channel ID', () => {
    const data = {
      'sess-1': { channelId: 'C001', active: true },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = manager.getSessionByChannelId('C001');
    assert.equal(result.sessionId, 'sess-1');
  });

  it('returns null for unknown channel', () => {
    fs.writeFileSync(manager.channelMapPath, '{}');
    assert.equal(manager.getSessionByChannelId('C999'), null);
  });
});

describe('SlackChannelManager.getOrCreateChannel', () => {
  let tempDir;
  let manager;
  let mockCalls;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client, calls } = createMockSlackClient();
    mockCalls = calls;
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
      inviteUserId: 'U12345',
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('creates a channel and writes mapping', async () => {
    const result = await manager.getOrCreateChannel('sess-1', 'myproject', '/tmp/myproject', 'tmux-sess');
    assert.ok(result.channelId);
    assert.equal(result.active, true);
    assert.equal(result.project, 'myproject');

    // Verify it's in the map
    const mapping = manager.getChannelMapping('sess-1');
    assert.ok(mapping);
  });

  it('returns existing mapping if already exists', async () => {
    const data = {
      'sess-1': { channelId: 'C_EXISTING', channelName: 'cn-test', active: true },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.getOrCreateChannel('sess-1', 'test', '/tmp', null);
    assert.equal(result.channelId, 'C_EXISTING');
  });

  it('invites user when inviteUserId is set', async () => {
    await manager.getOrCreateChannel('sess-2', 'proj', '/tmp/proj', null);
    const inviteCalls = mockCalls.filter(c => c.method === 'conversations.invite');
    assert.ok(inviteCalls.length > 0);
    assert.equal(inviteCalls[0].args.users, 'U12345');
  });

  it('retries with suffix on name_taken error', async () => {
    let callCount = 0;
    manager.client.conversations.create = async (opts) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('name_taken');
        err.data = { error: 'name_taken' };
        throw err;
      }
      return { channel: { id: 'C_RETRY', name: opts.name } };
    };

    const result = await manager.getOrCreateChannel('sess-3', 'proj', '/tmp/proj', null);
    assert.equal(result.channelId, 'C_RETRY');
    assert.equal(callCount, 2);
  });
});

describe('SlackChannelManager.postToSessionChannel', () => {
  let tempDir;
  let manager;
  let mockCalls;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client, calls } = createMockSlackClient();
    mockCalls = calls;
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('posts text to session channel', async () => {
    const data = { 'sess-1': { channelId: 'C001', active: true } };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.postToSessionChannel('sess-1', 'Hello');
    assert.equal(result, true);
  });

  it('returns false for missing mapping', async () => {
    fs.writeFileSync(manager.channelMapPath, '{}');
    const result = await manager.postToSessionChannel('nonexistent', 'Hello');
    assert.equal(result, false);
  });

  it('chunks long text at 39500 chars', async () => {
    const data = { 'sess-1': { channelId: 'C001', active: true } };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const longText = 'a'.repeat(40000);
    await manager.postToSessionChannel('sess-1', longText);

    const postCalls = mockCalls.filter(c => c.method === 'chat.postMessage');
    assert.ok(postCalls.length >= 2);
  });

  it('marks inactive on channel_not_found', async () => {
    const data = { 'sess-1': { channelId: 'C001', active: true } };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    manager.client.chat.postMessage = async () => {
      const err = new Error('channel_not_found');
      err.data = { error: 'channel_not_found' };
      throw err;
    };

    const result = await manager.postToSessionChannel('sess-1', 'Hello');
    assert.equal(result, false);

    // Should mark inactive
    assert.equal(manager.getChannelMapping('sess-1'), null);
  });
});

describe('SlackChannelManager.archiveChannel', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('marks session as inactive with archivedAt', async () => {
    const data = {
      'sess-1': { channelId: 'C001', active: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    await manager.archiveChannel('C001');
    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['sess-1'].active, false);
    assert.ok(map['sess-1'].archivedAt);
  });
});

describe('SlackChannelManager.setTypingIndicator', () => {
  let tempDir;
  let manager;
  let calls;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const mock = createMockSlackClient();
    calls = mock.calls;
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = mock.client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('adds hourglass reaction and stores pendingMessageTs', async () => {
    const data = {
      'sess-1': { channelId: 'C001', active: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    await manager.setTypingIndicator('C001', '1234.5678');

    // Verify reaction was added
    const addCall = calls.find(c => c.method === 'reactions.add');
    assert.ok(addCall, 'Should call reactions.add');
    assert.equal(addCall.args.channel, 'C001');
    assert.equal(addCall.args.name, 'hourglass_flowing_sand');

    // Verify pendingMessageTs was stored
    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['sess-1'].pendingMessageTs, '1234.5678');
  });

  it('handles already_reacted error gracefully', async () => {
    const data = {
      'sess-1': { channelId: 'C001', active: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    // Override reactions.add to throw already_reacted
    manager.client.reactions.add = async () => {
      const err = new Error('already_reacted');
      err.data = { error: 'already_reacted' };
      throw err;
    };

    // Should not throw
    await manager.setTypingIndicator('C001', '1234.5678');

    // pendingMessageTs should still be stored
    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['sess-1'].pendingMessageTs, '1234.5678');
  });
});

describe('SlackChannelManager.clearTypingIndicator', () => {
  let tempDir;
  let manager;
  let calls;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const mock = createMockSlackClient();
    calls = mock.calls;
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = mock.client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('removes hourglass reaction but preserves pendingMessageTs', async () => {
    const data = {
      'sess-1': {
        channelId: 'C001', active: true,
        pendingMessageTs: '1234.5678',
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    await manager.clearTypingIndicator('sess-1');

    // Verify reaction was removed
    const removeCall = calls.find(c => c.method === 'reactions.remove');
    assert.ok(removeCall, 'Should call reactions.remove');
    assert.equal(removeCall.args.channel, 'C001');
    assert.equal(removeCall.args.name, 'hourglass_flowing_sand');
    assert.equal(removeCall.args.timestamp, '1234.5678');

    // pendingMessageTs should be preserved (not cleared) for threading
    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['sess-1'].pendingMessageTs, '1234.5678');
  });

  it('does nothing for unknown session', async () => {
    fs.writeFileSync(manager.channelMapPath, JSON.stringify({}));
    await manager.clearTypingIndicator('unknown-session');
    assert.equal(calls.length, 0, 'Should not call any Slack API');
  });

  it('does nothing when no pendingMessageTs', async () => {
    const data = {
      'sess-1': { channelId: 'C001', active: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    await manager.clearTypingIndicator('sess-1');
    assert.equal(calls.length, 0, 'Should not call any Slack API');
  });

  it('handles no_reaction error gracefully', async () => {
    const data = {
      'sess-1': {
        channelId: 'C001', active: true,
        pendingMessageTs: '1234.5678',
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    manager.client.reactions.remove = async () => {
      const err = new Error('no_reaction');
      err.data = { error: 'no_reaction' };
      throw err;
    };

    // Should not throw
    await manager.clearTypingIndicator('sess-1');
    // pendingMessageTs preserved (reaction removal is best-effort)
    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['sess-1'].pendingMessageTs, '1234.5678');
  });
});

describe('SlackChannelManager.updateProgressMessage', () => {
  let tempDir;
  let manager;
  let calls;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const mock = createMockSlackClient();
    calls = mock.calls;
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = mock.client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('posts new message as thread reply when pendingMessageTs exists', async () => {
    const data = {
      'sess-1': { channelId: 'C001', active: true, pendingMessageTs: '1111.2222', createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.updateProgressMessage('sess-1', 'Working...');
    assert.equal(result, true);

    const postCall = calls.find(c => c.method === 'chat.postMessage');
    assert.ok(postCall, 'Should call chat.postMessage');
    assert.equal(postCall.args.text, 'Working...');
    assert.equal(postCall.args.thread_ts, '1111.2222', 'Should thread on pendingMessageTs');

    // Verify progressMessageTs was stored
    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.ok(map['sess-1'].progressMessageTs, 'Should store progressMessageTs');
  });

  it('posts top-level message when no pendingMessageTs', async () => {
    const data = {
      'sess-1': { channelId: 'C001', active: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.updateProgressMessage('sess-1', 'Working...');
    assert.equal(result, true);

    const postCall = calls.find(c => c.method === 'chat.postMessage');
    assert.ok(postCall, 'Should call chat.postMessage');
    assert.equal(postCall.args.thread_ts, undefined, 'Should not have thread_ts');
  });

  it('updates existing message when progressMessageTs exists', async () => {
    const data = {
      'sess-1': {
        channelId: 'C001', active: true,
        progressMessageTs: '9999.0001',
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.updateProgressMessage('sess-1', 'Still working...');
    assert.equal(result, true);

    const updateCall = calls.find(c => c.method === 'chat.update');
    assert.ok(updateCall, 'Should call chat.update');
    assert.equal(updateCall.args.ts, '9999.0001');
    assert.equal(updateCall.args.text, 'Still working...');
  });

  it('returns false for unknown session', async () => {
    fs.writeFileSync(manager.channelMapPath, JSON.stringify({}));
    const result = await manager.updateProgressMessage('unknown', 'text');
    assert.equal(result, false);
  });

  it('returns false for inactive session', async () => {
    const data = {
      'sess-1': { channelId: 'C001', active: false, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.updateProgressMessage('sess-1', 'text');
    assert.equal(result, false);
  });

  it('retries with postMessage on message_not_found', async () => {
    const data = {
      'sess-1': {
        channelId: 'C001', active: true,
        progressMessageTs: '9999.0001',
        pendingMessageTs: '1111.2222',
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    // Make chat.update throw message_not_found
    manager.client.chat.update = async () => {
      const err = new Error('message_not_found');
      err.data = { error: 'message_not_found' };
      throw err;
    };

    const result = await manager.updateProgressMessage('sess-1', 'Retry text');
    assert.equal(result, true);

    // Should have fallen back to postMessage with thread_ts
    const postCall = calls.find(c => c.method === 'chat.postMessage');
    assert.ok(postCall, 'Should fall back to chat.postMessage');
    assert.equal(postCall.args.text, 'Retry text');
    assert.equal(postCall.args.thread_ts, '1111.2222', 'Fallback should thread on pendingMessageTs');
  });
});

describe('SlackChannelManager.clearProgressMessage', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('removes progressMessageTs from channel map entry', () => {
    const data = {
      'sess-1': {
        channelId: 'C001', active: true,
        progressMessageTs: '9999.0001',
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    manager.clearProgressMessage('sess-1');

    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['sess-1'].progressMessageTs, undefined);
  });

  it('does nothing for unknown session', () => {
    fs.writeFileSync(manager.channelMapPath, JSON.stringify({}));
    // Should not throw
    manager.clearProgressMessage('unknown');
  });

  it('preserves pendingMessageTs written by concurrent process', async () => {
    const data = {
      'sess-1': {
        channelId: 'C001', active: true,
        progressMessageTs: '9999.0001',
        pendingMessageTs: '1111.0001',
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    // Simulate concurrent setTypingIndicator writing a new pendingMessageTs
    // during the chat.delete API call by overriding chat.delete to write mid-flight
    manager.client.chat = {
      ...manager.client.chat,
      delete: async () => {
        // Simulate another process writing a new pendingMessageTs during the API call
        const concurrentMap = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
        concurrentMap['sess-1'].pendingMessageTs = '2222.0002';
        fs.writeFileSync(manager.channelMapPath, JSON.stringify(concurrentMap));
      },
    };

    await manager.clearProgressMessage('sess-1');

    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['sess-1'].progressMessageTs, undefined, 'progressMessageTs should be deleted');
    assert.equal(map['sess-1'].pendingMessageTs, '2222.0002', 'concurrent pendingMessageTs should be preserved');
  });
});

describe('SlackChannelManager.postToThread', () => {
  let tempDir;
  let manager;
  let calls;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const mock = createMockSlackClient();
    calls = mock.calls;
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = mock.client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('posts text as thread reply', async () => {
    const data = {
      'sess-1': { channelId: 'C001', active: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.postToThread('sess-1', '1234.5678', 'Thread reply');
    assert.equal(result, true);

    const postCall = calls.find(c => c.method === 'chat.postMessage');
    assert.ok(postCall);
    assert.equal(postCall.args.channel, 'C001');
    assert.equal(postCall.args.thread_ts, '1234.5678');
    assert.equal(postCall.args.text, 'Thread reply');
  });

  it('returns false for missing mapping', async () => {
    fs.writeFileSync(manager.channelMapPath, JSON.stringify({}));
    const result = await manager.postToThread('unknown', '1234.5678', 'text');
    assert.equal(result, false);
  });

  it('returns false on API error', async () => {
    const data = {
      'sess-1': { channelId: 'C001', active: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    manager.client.chat.postMessage = async () => {
      throw new Error('channel_not_found');
    };

    const result = await manager.postToThread('sess-1', '1234.5678', 'text');
    assert.equal(result, false);
  });
});

describe('SlackChannelManager.reuseChannelForTmuxSession', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('remaps new session to existing channel on same tmux session', () => {
    const data = {
      'old-sess': {
        channelId: 'C001',
        channelName: 'cn-project-old',
        tmuxSession: 'claude-tmux-1',
        project: 'myproject',
        cwd: '/tmp/myproject',
        active: true,
        pendingMessageTs: '1234.5678',
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = manager.reuseChannelForTmuxSession('new-sess', 'claude-tmux-1');
    assert.ok(result);
    assert.equal(result.channelId, 'C001');
    assert.equal(result.tmuxSession, 'claude-tmux-1');
    assert.equal(result.pendingMessageTs, null);

    // Old session should be deactivated
    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['old-sess'].active, false);
    assert.equal(map['new-sess'].active, true);
    assert.equal(map['new-sess'].channelId, 'C001');
  });

  it('returns null when no active channel exists for tmux session', () => {
    fs.writeFileSync(manager.channelMapPath, '{}');
    const result = manager.reuseChannelForTmuxSession('new-sess', 'claude-tmux-1');
    assert.equal(result, null);
  });

  it('returns null when tmux session is null', () => {
    fs.writeFileSync(manager.channelMapPath, '{}');
    const result = manager.reuseChannelForTmuxSession('new-sess', null);
    assert.equal(result, null);
  });

  it('returns existing mapping if new session already has one', () => {
    const data = {
      'new-sess': {
        channelId: 'C002',
        tmuxSession: 'claude-tmux-1',
        active: true,
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = manager.reuseChannelForTmuxSession('new-sess', 'claude-tmux-1');
    assert.equal(result.channelId, 'C002');
  });

  it('does not match inactive channels', () => {
    const data = {
      'old-sess': {
        channelId: 'C001',
        tmuxSession: 'claude-tmux-1',
        active: false,
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = manager.reuseChannelForTmuxSession('new-sess', 'claude-tmux-1');
    assert.equal(result, null);
  });

  it('does not match channels on different tmux sessions', () => {
    const data = {
      'old-sess': {
        channelId: 'C001',
        tmuxSession: 'claude-tmux-2',
        active: true,
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = manager.reuseChannelForTmuxSession('new-sess', 'claude-tmux-1');
    assert.equal(result, null);
  });

  it('clears progressMessageTs on remap', () => {
    const data = {
      'old-sess': {
        channelId: 'C001',
        tmuxSession: 'claude-tmux-1',
        active: true,
        progressMessageTs: '9999.1234',
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = manager.reuseChannelForTmuxSession('new-sess', 'claude-tmux-1');
    assert.equal(result.progressMessageTs, undefined);
  });
});
