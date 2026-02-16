import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlist, SERVICE_LABEL } from '../../../lib/service.js';

describe('generatePlist', () => {
  const plist = generatePlist();

  it('is valid XML', () => {
    assert.ok(plist.startsWith('<?xml'));
  });

  it('contains the correct service label', () => {
    assert.ok(plist.includes(`<string>${SERVICE_LABEL}</string>`));
  });

  it('contains the node path', () => {
    assert.ok(plist.includes(process.execPath));
  });

  it('contains the webhook script path', () => {
    assert.ok(plist.includes('start-webhook.cjs'));
  });

  it('has RunAtLoad set to true', () => {
    assert.ok(plist.includes('<key>RunAtLoad</key>'));
    assert.ok(plist.includes('<true/>'));
  });

  it('has KeepAlive set to true', () => {
    assert.ok(plist.includes('<key>KeepAlive</key>'));
  });

  it('includes PATH environment variable', () => {
    assert.ok(plist.includes('<key>PATH</key>'));
  });

  it('contains ProgramArguments array', () => {
    assert.ok(plist.includes('<key>ProgramArguments</key>'));
    assert.ok(plist.includes('<array>'));
  });
});

describe('SERVICE_LABEL', () => {
  it('is the expected string', () => {
    assert.equal(SERVICE_LABEL, 'claude-nonstop-slack');
  });
});
