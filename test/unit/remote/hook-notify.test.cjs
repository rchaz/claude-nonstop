const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDir, removeTempDir } = require('../../helpers/temp-dir.cjs');

const {
  getLastAssistantMessage, parseCurrentTurn, isPerSessionMode, markdownToMrkdwn,
  extractToolDetail, formatProgressMessage, formatWaitingMessage, findTranscriptPath,
  readProgressBuffer, writeProgressBuffer, appendToProgressBuffer, progressBufferPath,
  FLUSH_INTERVAL_MS, WAITING_FOR_INPUT_TOOLS,
} = require('../../../remote/hook-notify.cjs');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'fixtures', 'transcripts');

describe('getLastAssistantMessage', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('extracts text from simple session', () => {
    const result = getLastAssistantMessage(path.join(FIXTURES_DIR, 'simple-session.jsonl'));
    assert.ok(result.includes('happy to help'));
  });

  it('returns null for missing file', () => {
    assert.equal(getLastAssistantMessage('/nonexistent/file.jsonl'), null);
  });

  it('truncates at maxLength', () => {
    const result = getLastAssistantMessage(path.join(FIXTURES_DIR, 'simple-session.jsonl'), 10);
    assert.ok(result.length <= 13); // 10 + '...'
    assert.ok(result.endsWith('...'));
  });

  it('does not truncate when text is shorter than maxLength', () => {
    const result = getLastAssistantMessage(path.join(FIXTURES_DIR, 'simple-session.jsonl'), 1000);
    assert.ok(!result.endsWith('...'));
  });

  it('returns null for empty file', () => {
    const emptyFile = path.join(tempDir, 'empty.jsonl');
    fs.writeFileSync(emptyFile, '');
    assert.equal(getLastAssistantMessage(emptyFile), null);
  });

  it('returns the last assistant message from multi-turn', () => {
    const result = getLastAssistantMessage(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    assert.ok(result.includes('update the value'));
  });
});

describe('parseCurrentTurn', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('extracts tool_use entries', () => {
    const result = parseCurrentTurn(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    assert.ok(result.toolUses.length > 0);
    assert.equal(result.toolUses[0].tool, 'Edit');
  });

  it('extracts file path from input', () => {
    const result = parseCurrentTurn(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    const editTool = result.toolUses.find(t => t.tool === 'Edit');
    assert.ok(editTool);
    assert.equal(editTool.file, '/tmp/config.json');
  });

  it('extracts summary text from last assistant text block', () => {
    const result = parseCurrentTurn(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    assert.equal(result.summary, "I'll update the value in the config file.");
  });

  it('stops at user message boundary', () => {
    // The multi-turn transcript has a user message in the middle
    // parseCurrentTurn should only get the last turn
    const result = parseCurrentTurn(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    // Should only have the Edit tool from the last turn, not the Read from the first
    const tools = result.toolUses.map(t => t.tool);
    assert.ok(tools.includes('Edit'));
    assert.ok(!tools.includes('Read'));
  });

  it('returns empty result for missing file', () => {
    const result = parseCurrentTurn('/nonexistent/file.jsonl');
    assert.deepEqual(result.toolUses, []);
    assert.equal(result.summary, null);
  });

  it('returns empty result for empty file', () => {
    const emptyFile = path.join(tempDir, 'empty.jsonl');
    fs.writeFileSync(emptyFile, '');
    const result = parseCurrentTurn(emptyFile);
    assert.deepEqual(result.toolUses, []);
  });
});

describe('isPerSessionMode', () => {
  let origRemote;
  let origToken;

  beforeEach(() => {
    origRemote = process.env.CLAUDE_REMOTE_ACCESS;
    origToken = process.env.SLACK_BOT_TOKEN;
  });

  afterEach(() => {
    if (origRemote !== undefined) process.env.CLAUDE_REMOTE_ACCESS = origRemote;
    else delete process.env.CLAUDE_REMOTE_ACCESS;
    if (origToken !== undefined) process.env.SLACK_BOT_TOKEN = origToken;
    else delete process.env.SLACK_BOT_TOKEN;
  });

  it('returns true when both env vars set', () => {
    process.env.CLAUDE_REMOTE_ACCESS = 'true';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    assert.equal(isPerSessionMode(), true);
  });

  it('returns false when CLAUDE_REMOTE_ACCESS not set', () => {
    delete process.env.CLAUDE_REMOTE_ACCESS;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    assert.equal(isPerSessionMode(), false);
  });

  it('returns false when SLACK_BOT_TOKEN not set', () => {
    process.env.CLAUDE_REMOTE_ACCESS = 'true';
    delete process.env.SLACK_BOT_TOKEN;
    assert.equal(isPerSessionMode(), false);
  });

  it('returns false when CLAUDE_REMOTE_ACCESS is not "true"', () => {
    process.env.CLAUDE_REMOTE_ACCESS = 'false';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    assert.equal(isPerSessionMode(), false);
  });
});

describe('markdownToMrkdwn (re-exported)', () => {
  it('is the same function as from channel-manager', () => {
    const { markdownToMrkdwn: fromCm } = require('../../../remote/channel-manager.cjs');
    assert.equal(markdownToMrkdwn, fromCm);
  });
});

describe('extractToolDetail', () => {
  it('extracts file_path', () => {
    assert.equal(extractToolDetail('Read', { file_path: '/src/app.js' }), '/src/app.js');
  });

  it('extracts command', () => {
    assert.equal(extractToolDetail('Bash', { command: 'npm test' }), 'npm test');
  });

  it('truncates long commands to 120 chars', () => {
    const long = 'a'.repeat(200);
    assert.equal(extractToolDetail('Bash', { command: long }).length, 120);
  });

  it('extracts pattern', () => {
    assert.equal(extractToolDetail('Grep', { pattern: '*.js' }), '*.js');
  });

  it('extracts query', () => {
    assert.equal(extractToolDetail('WebSearch', { query: 'node.js streams' }), 'node.js streams');
  });

  it('extracts path', () => {
    assert.equal(extractToolDetail('Glob', { path: '/src' }), '/src');
  });

  it('extracts url', () => {
    assert.equal(extractToolDetail('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  });

  it('extracts prompt', () => {
    const result = extractToolDetail('Task', { prompt: 'Search for files' });
    assert.equal(result, 'Search for files');
  });

  it('truncates long prompts to 80 chars', () => {
    const long = 'a'.repeat(200);
    assert.equal(extractToolDetail('Task', { prompt: long }).length, 80);
  });

  it('returns null for empty input', () => {
    assert.equal(extractToolDetail('Read', {}), null);
  });

  it('returns null for null input', () => {
    assert.equal(extractToolDetail('Read', null), null);
  });

  it('returns null for non-object input', () => {
    assert.equal(extractToolDetail('Read', 'string'), null);
  });

  it('prefers file_path over command', () => {
    assert.equal(extractToolDetail('Edit', { file_path: '/file.js', command: 'echo' }), '/file.js');
  });
});

describe('formatProgressMessage', () => {
  it('returns default message for empty events', () => {
    assert.equal(formatProgressMessage([]), ':hourglass_flowing_sand: Working...');
  });

  it('returns default message for null events', () => {
    assert.equal(formatProgressMessage(null), ':hourglass_flowing_sand: Working...');
  });

  it('formats single event', () => {
    const now = Date.now();
    const result = formatProgressMessage([{ type: 'Read', detail: '/file.js', ts: now }]);
    assert.ok(result.includes(':hourglass_flowing_sand: Working...'));
    assert.ok(result.includes('Read'));
    assert.ok(result.includes('`/file.js`'));
    assert.ok(!result.includes('_Updated'));
  });

  it('formats event without detail', () => {
    const now = Date.now();
    const result = formatProgressMessage([{ type: 'Bash', detail: null, ts: now }]);
    assert.ok(result.includes('Bash'));
    assert.ok(!result.includes('`'));
  });

  it('deduplicates consecutive same events', () => {
    const now = Date.now();
    const events = [
      { type: 'Read', detail: '/file.js', ts: now },
      { type: 'Read', detail: '/file.js', ts: now },
      { type: 'Read', detail: '/file.js', ts: now },
    ];
    const result = formatProgressMessage(events);
    const readMatches = result.match(/Read/g);
    assert.equal(readMatches.length, 1);
  });

  it('keeps different consecutive events', () => {
    const now = Date.now();
    const events = [
      { type: 'Read', detail: '/a.js', ts: now },
      { type: 'Edit', detail: '/a.js', ts: now },
      { type: 'Read', detail: '/b.js', ts: now },
    ];
    const result = formatProgressMessage(events);
    assert.ok(result.includes('Read'));
    assert.ok(result.includes('Edit'));
  });

  it('limits to 8 recent events', () => {
    const now = Date.now();
    const events = [];
    for (let i = 0; i < 15; i++) {
      events.push({ type: `Tool${i}`, detail: `/file${i}.js`, ts: now });
    }
    const result = formatProgressMessage(events);
    // Should only show last 8 distinct events
    const bulletCount = (result.match(/\u2022/g) || []).length;
    assert.ok(bulletCount <= 8);
  });

});

describe('FLUSH_INTERVAL_MS', () => {
  it('is 3 seconds', () => {
    assert.equal(FLUSH_INTERVAL_MS, 3000);
  });
});

describe('progressBufferPath', () => {
  it('returns a path containing the session ID', () => {
    const p = progressBufferPath('abc-123');
    assert.ok(p.includes('progress-abc-123.json'));
    assert.ok(p.includes('progress'));
  });

  it('returns different paths for different sessions', () => {
    assert.notEqual(progressBufferPath('sess-1'), progressBufferPath('sess-2'));
  });
});

describe('readProgressBuffer / writeProgressBuffer', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('returns empty buffer for nonexistent file with lastFlushTs=0 for immediate flush', () => {
    const buf = readProgressBuffer(path.join(tempDir, 'nope.json'));
    assert.deepEqual(buf.events, []);
    assert.strictEqual(buf.lastFlushTs, 0, 'lastFlushTs should be 0 so first event flushes immediately');
  });

  it('returns empty buffer for empty file with current timestamp', () => {
    const p = path.join(tempDir, 'empty.json');
    fs.writeFileSync(p, '');
    const before = Date.now();
    const buf = readProgressBuffer(p);
    assert.deepEqual(buf.events, []);
    assert.ok(buf.lastFlushTs >= before);
  });

  it('returns empty buffer for corrupt JSON with current timestamp', () => {
    const p = path.join(tempDir, 'bad.json');
    fs.writeFileSync(p, '{not json');
    const before = Date.now();
    const buf = readProgressBuffer(p);
    assert.deepEqual(buf.events, []);
    assert.ok(buf.lastFlushTs >= before);
  });

  it('round-trips buffer through write and read', () => {
    const p = path.join(tempDir, 'buf.json');
    const buf = {
      events: [{ type: 'Read', detail: '/f.js', ts: 1000 }],
      lastFlushTs: 500,
    };
    writeProgressBuffer(p, buf);
    const result = readProgressBuffer(p);
    assert.deepEqual(result, buf);
  });

  it('creates parent directories if missing', () => {
    const p = path.join(tempDir, 'sub', 'dir', 'buf.json');
    writeProgressBuffer(p, { events: [], lastFlushTs: 0 });
    assert.ok(fs.existsSync(p));
  });

  it('writes atomically (no .tmp left behind)', () => {
    const p = path.join(tempDir, 'buf.json');
    writeProgressBuffer(p, { events: [], lastFlushTs: 0 });
    const files = fs.readdirSync(tempDir);
    assert.ok(!files.some(f => f.endsWith('.tmp')));
  });
});

describe('appendToProgressBuffer', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('creates buffer file on first event', () => {
    const p = path.join(tempDir, 'buf.json');
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: 1000 });
    assert.equal(buf.events.length, 1);
    assert.equal(buf.events[0].type, 'Read');
    assert.ok(fs.existsSync(p));
  });

  it('appends to existing buffer', () => {
    const p = path.join(tempDir, 'buf.json');
    appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: 1000 });
    const buf = appendToProgressBuffer(p, { type: 'Edit', detail: '/a.js', ts: 2000 });
    assert.equal(buf.events.length, 2);
    assert.equal(buf.events[0].type, 'Read');
    assert.equal(buf.events[1].type, 'Edit');
  });

  it('preserves lastFlushTs', () => {
    const p = path.join(tempDir, 'buf.json');
    writeProgressBuffer(p, { events: [], lastFlushTs: 5000 });
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: 6000 });
    assert.equal(buf.lastFlushTs, 5000);
  });

  it('caps events at 100', () => {
    const p = path.join(tempDir, 'buf.json');
    for (let i = 0; i < 110; i++) {
      appendToProgressBuffer(p, { type: `Tool${i}`, detail: null, ts: i });
    }
    const buf = readProgressBuffer(p);
    assert.equal(buf.events.length, 100);
    // Should keep the last 100 (Tool10..Tool109)
    assert.equal(buf.events[0].type, 'Tool10');
    assert.equal(buf.events[99].type, 'Tool109');
  });
});

describe('flush timing logic', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('first event SHOULD flush (lastFlushTs starts at 0 for immediate progress)', () => {
    const p = path.join(tempDir, 'buf.json');
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: Date.now() });
    // New buffer gets lastFlushTs=0, so now - 0 >= FLUSH_INTERVAL_MS
    const now = Date.now();
    assert.ok(now - buf.lastFlushTs >= FLUSH_INTERVAL_MS, 'first event should flush immediately');
  });

  it('should not flush when interval has not elapsed', () => {
    const p = path.join(tempDir, 'buf.json');
    const now = Date.now();
    // Simulate a recent flush
    writeProgressBuffer(p, { events: [], lastFlushTs: now });
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: now + 100 });
    const checkTime = now + 100;
    assert.ok(checkTime - buf.lastFlushTs < FLUSH_INTERVAL_MS);
  });

  it('should flush when interval has elapsed', () => {
    const p = path.join(tempDir, 'buf.json');
    const now = Date.now();
    // Simulate an old flush
    const oldFlush = now - FLUSH_INTERVAL_MS - 1;
    writeProgressBuffer(p, { events: [], lastFlushTs: oldFlush });
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: now });
    assert.ok(now - buf.lastFlushTs >= FLUSH_INTERVAL_MS);
  });

  it('simulates rapid tool calls with correct flush decisions', () => {
    const p = path.join(tempDir, 'buf.json');
    const t0 = Date.now();

    // Event 1 at t=0: SHOULD flush (new buffer, lastFlushTs=0)
    let buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: t0 });
    assert.ok(t0 - buf.lastFlushTs >= FLUSH_INTERVAL_MS, 'first event should flush immediately');

    // Simulate that flush happened: set lastFlushTs to t0
    buf.lastFlushTs = t0;
    writeProgressBuffer(p, buf);

    // Event 2 at t+500ms: should NOT flush
    buf = appendToProgressBuffer(p, { type: 'Edit', detail: '/a.js', ts: t0 + 500 });
    assert.ok((t0 + 500) - buf.lastFlushTs < FLUSH_INTERVAL_MS, 'event at +500ms should not flush');

    // Event 3 at t+1s: should NOT flush
    buf = appendToProgressBuffer(p, { type: 'Bash', detail: 'npm test', ts: t0 + 1000 });
    assert.ok((t0 + 1000) - buf.lastFlushTs < FLUSH_INTERVAL_MS, 'event at +1s should not flush');
    assert.equal(buf.events.length, 3, 'buffer should have 3 unflushed events');

    // Event 4 at t+3.5s: should flush (>3s since last flush at t0)
    buf = appendToProgressBuffer(p, { type: 'Read', detail: '/b.js', ts: t0 + 3500 });
    assert.ok((t0 + 3500) - buf.lastFlushTs >= FLUSH_INTERVAL_MS, 'event at +3.5s should flush');
    assert.equal(buf.events.length, 4, 'buffer should have 4 events to flush');

    // Simulate flush: clear events, update lastFlushTs
    buf.events = [];
    buf.lastFlushTs = t0 + 3500;
    writeProgressBuffer(p, buf);

    // Verify buffer is clean after flush
    buf = readProgressBuffer(p);
    assert.equal(buf.events.length, 0);
    assert.equal(buf.lastFlushTs, t0 + 3500);
  });
});

describe('WAITING_FOR_INPUT_TOOLS', () => {
  it('includes ExitPlanMode', () => {
    assert.ok(WAITING_FOR_INPUT_TOOLS.has('ExitPlanMode'));
  });

  it('includes AskUserQuestion', () => {
    assert.ok(WAITING_FOR_INPUT_TOOLS.has('AskUserQuestion'));
  });

  it('does not include regular tools', () => {
    assert.ok(!WAITING_FOR_INPUT_TOOLS.has('Read'));
    assert.ok(!WAITING_FOR_INPUT_TOOLS.has('Bash'));
    assert.ok(!WAITING_FOR_INPUT_TOOLS.has('Edit'));
  });
});

describe('formatWaitingMessage', () => {
  it('returns generic plan message for ExitPlanMode without transcript content', () => {
    const msg = formatWaitingMessage('ExitPlanMode', {});
    assert.ok(msg.includes(':clipboard:'));
    assert.ok(msg.includes('Plan ready'));
    assert.ok(msg.includes('!status'));
  });

  it('returns generic plan message when transcriptContent is null', () => {
    const msg = formatWaitingMessage('ExitPlanMode', {}, null);
    assert.ok(msg.includes('Plan ready'));
    assert.ok(msg.includes('!status'));
  });

  it('includes plan content when transcriptContent is provided', () => {
    const plan = '## Plan\n\n1. **Add Redis** - Create cache layer\n2. **Update routes** - Add middleware';
    const msg = formatWaitingMessage('ExitPlanMode', {}, plan);
    assert.ok(msg.includes(':clipboard:'));
    assert.ok(msg.includes('*Plan ready'));
    assert.ok(msg.includes('waiting for approval'));
    assert.ok(msg.includes('Add Redis'));
    assert.ok(msg.includes('Update routes'));
    // Should not include the !status fallback when content is present
    assert.ok(!msg.includes('!status'));
  });

  it('converts markdown to Slack mrkdwn in plan content', () => {
    const plan = '**Bold text** and [a link](https://example.com)';
    const msg = formatWaitingMessage('ExitPlanMode', {}, plan);
    // **bold** becomes *bold* in mrkdwn
    assert.ok(msg.includes('*Bold text*'));
    // [text](url) becomes <url|text> in mrkdwn
    assert.ok(msg.includes('<https://example.com|a link>'));
  });

  it('truncates very long plan content to 39000 chars', () => {
    const longPlan = 'x'.repeat(40000);
    const msg = formatWaitingMessage('ExitPlanMode', {}, longPlan);
    assert.ok(msg.length < 40000);
    assert.ok(msg.endsWith('...'));
  });

  it('does not truncate plan content under 39000 chars', () => {
    const plan = 'Short plan content';
    const msg = formatWaitingMessage('ExitPlanMode', {}, plan);
    assert.ok(!msg.endsWith('...'));
    assert.ok(msg.includes('Short plan content'));
  });

  it('ignores toolInput for ExitPlanMode', () => {
    const msg = formatWaitingMessage('ExitPlanMode', { something: 'irrelevant' });
    assert.ok(msg.includes('Plan ready'));
  });

  it('returns question text for AskUserQuestion with questions', () => {
    const input = {
      questions: [{ question: 'Which database should we use?' }],
    };
    const msg = formatWaitingMessage('AskUserQuestion', input);
    assert.ok(msg.includes(':question:'));
    assert.ok(msg.includes('Which database should we use?'));
    assert.ok(msg.includes('!status'));
  });

  it('truncates long question text to 200 chars', () => {
    const longQuestion = 'a'.repeat(300);
    const input = {
      questions: [{ question: longQuestion }],
    };
    const msg = formatWaitingMessage('AskUserQuestion', input);
    assert.ok(msg.includes('a'.repeat(200) + '...'));
    assert.ok(!msg.includes('a'.repeat(201)));
  });

  it('returns generic message for AskUserQuestion without questions', () => {
    const msg = formatWaitingMessage('AskUserQuestion', {});
    assert.ok(msg.includes(':question:'));
    assert.ok(msg.includes('asking a question'));
  });

  it('returns generic message for AskUserQuestion with empty questions array', () => {
    const msg = formatWaitingMessage('AskUserQuestion', { questions: [] });
    assert.ok(msg.includes('asking a question'));
  });

  it('returns generic message for AskUserQuestion with null input', () => {
    const msg = formatWaitingMessage('AskUserQuestion', null);
    assert.ok(msg.includes('asking a question'));
  });

  it('uses first question when multiple exist', () => {
    const input = {
      questions: [
        { question: 'First question?' },
        { question: 'Second question?' },
      ],
    };
    const msg = formatWaitingMessage('AskUserQuestion', input);
    assert.ok(msg.includes('First question?'));
    assert.ok(!msg.includes('Second question?'));
  });

  it('returns fallback message for unknown tool', () => {
    const msg = formatWaitingMessage('SomeUnknownTool', {});
    assert.ok(msg.includes(':hourglass:'));
    assert.ok(msg.includes('Waiting for input'));
  });

  it('ignores transcriptContent for non-ExitPlanMode tools', () => {
    const msg = formatWaitingMessage('AskUserQuestion', null, 'some plan text');
    assert.ok(msg.includes('asking a question'));
    assert.ok(!msg.includes('some plan text'));
  });
});

describe('findTranscriptPath', () => {
  let tempDir;
  let origConfigDir;

  beforeEach(() => {
    tempDir = createTempDir();
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    removeTempDir(tempDir);
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    else delete process.env.CLAUDE_CONFIG_DIR;
  });

  it('returns path when transcript file exists', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const cwd = '/Users/test/myproject';
    const sessionId = 'abc-123-def';
    const cwdHash = cwd.replace(/\//g, '-');
    const projectDir = path.join(tempDir, 'projects', cwdHash);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{}');

    const result = findTranscriptPath(sessionId, cwd);
    assert.ok(result);
    assert.ok(result.endsWith(`${sessionId}.jsonl`));
    assert.ok(result.includes('projects'));
  });

  it('returns null when transcript file does not exist', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const result = findTranscriptPath('nonexistent-session', '/some/path');
    assert.equal(result, null);
  });

  it('returns null when CLAUDE_CONFIG_DIR is not set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const result = findTranscriptPath('abc-123', '/some/path');
    assert.equal(result, null);
  });

  it('returns null when sessionId is null', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const result = findTranscriptPath(null, '/some/path');
    assert.equal(result, null);
  });

  it('returns null when cwd is null', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const result = findTranscriptPath('abc-123', null);
    assert.equal(result, null);
  });

  it('computes correct cwdHash from cwd', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const cwd = '/Users/rc/code/claude-nonstop';
    const sessionId = 'test-session';
    const expectedHash = '-Users-rc-code-claude-nonstop';
    const projectDir = path.join(tempDir, 'projects', expectedHash);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{}');

    const result = findTranscriptPath(sessionId, cwd);
    assert.ok(result);
    assert.ok(result.includes(expectedHash));
  });
});

describe('plan mode transcript integration', () => {
  it('getLastAssistantMessage extracts plan text from plan-mode transcript', () => {
    const transcriptPath = path.join(FIXTURES_DIR, 'plan-mode.jsonl');
    const result = getLastAssistantMessage(transcriptPath);
    assert.ok(result, 'should find plan text in transcript');
    assert.ok(result.includes('Implementation Plan'));
    assert.ok(result.includes('Add Redis client'));
    assert.ok(result.includes('cache middleware'));
  });

  it('parseCurrentTurn finds ExitPlanMode tool use in plan-mode transcript', () => {
    const transcriptPath = path.join(FIXTURES_DIR, 'plan-mode.jsonl');
    const result = parseCurrentTurn(transcriptPath);
    const exitPlan = result.toolUses.find(t => t.tool === 'ExitPlanMode');
    assert.ok(exitPlan, 'should find ExitPlanMode tool use');
  });

  it('parseCurrentTurn extracts plan summary from plan-mode transcript', () => {
    const transcriptPath = path.join(FIXTURES_DIR, 'plan-mode.jsonl');
    const result = parseCurrentTurn(transcriptPath);
    assert.ok(result.summary);
    assert.ok(result.summary.includes('plan'));
  });

  it('formatWaitingMessage with real transcript content produces complete plan message', () => {
    const transcriptPath = path.join(FIXTURES_DIR, 'plan-mode.jsonl');
    const planContent = getLastAssistantMessage(transcriptPath);
    const msg = formatWaitingMessage('ExitPlanMode', {}, planContent);
    assert.ok(msg.includes(':clipboard:'));
    assert.ok(msg.includes('*Plan ready'));
    assert.ok(msg.includes('Add Redis client'));
    assert.ok(msg.includes('cache middleware'));
    assert.ok(msg.includes('Files to modify'));
  });
});
