import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkAllUsage } from '../../lib/usage.js';
import { pickBestAccount } from '../../lib/scorer.js';

describe('scoring pipeline integration', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('mock fetch → checkAllUsage → pickBestAccount', async () => {
    const usageData = {
      'sk-ant-oat01-work': { five_hour: { utilization: 0.80 }, seven_day: { utilization: 0.60 } },
      'sk-ant-oat01-personal': { five_hour: { utilization: 0.20 }, seven_day: { utilization: 0.10 } },
      'sk-ant-oat01-team': { five_hour: { utilization: 0.50 }, seven_day: { utilization: 0.40 } },
    };

    globalThis.fetch = async (url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      const data = usageData[token] || {};
      return { ok: true, json: async () => data };
    };

    const accounts = [
      { name: 'work', configDir: '/tmp/work', token: 'sk-ant-oat01-work' },
      { name: 'personal', configDir: '/tmp/personal', token: 'sk-ant-oat01-personal' },
      { name: 'team', configDir: '/tmp/team', token: 'sk-ant-oat01-team' },
    ];

    const withUsage = await checkAllUsage(accounts);
    assert.equal(withUsage.length, 3);

    // Verify usage was populated
    assert.equal(withUsage[0].usage.sessionPercent, 80);
    assert.equal(withUsage[1].usage.sessionPercent, 20);
    assert.equal(withUsage[2].usage.sessionPercent, 50);

    // Pick best (should be personal with lowest utilization)
    const best = pickBestAccount(withUsage);
    assert.equal(best.account.name, 'personal');
  });

  it('handles mixed success and error accounts', async () => {
    globalThis.fetch = async (url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      if (token === 'sk-ant-oat01-broken') {
        return { ok: false, status: 401 };
      }
      return {
        ok: true,
        json: async () => ({ five_hour: { utilization: 0.50 }, seven_day: { utilization: 0.30 } }),
      };
    };

    const accounts = [
      { name: 'broken', configDir: '/tmp/broken', token: 'sk-ant-oat01-broken' },
      { name: 'working', configDir: '/tmp/working', token: 'sk-ant-oat01-working' },
    ];

    const withUsage = await checkAllUsage(accounts);
    const best = pickBestAccount(withUsage);

    assert.equal(best.account.name, 'working');
  });

  it('returns null when all accounts fail', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });

    const accounts = [
      { name: 'fail1', configDir: '/tmp/f1', token: 'sk-ant-oat01-f1' },
      { name: 'fail2', configDir: '/tmp/f2', token: 'sk-ant-oat01-f2' },
    ];

    const withUsage = await checkAllUsage(accounts);
    const best = pickBestAccount(withUsage);

    assert.equal(best, null);
  });

  it('excludes rate-limited account and picks next best', async () => {
    globalThis.fetch = async (url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      const utilizations = {
        'sk-ant-oat01-a': 0.10,
        'sk-ant-oat01-b': 0.30,
        'sk-ant-oat01-c': 0.50,
      };
      const util = utilizations[token] || 0;
      return {
        ok: true,
        json: async () => ({ five_hour: { utilization: util }, seven_day: { utilization: util } }),
      };
    };

    const accounts = [
      { name: 'a', configDir: '/tmp/a', token: 'sk-ant-oat01-a' },
      { name: 'b', configDir: '/tmp/b', token: 'sk-ant-oat01-b' },
      { name: 'c', configDir: '/tmp/c', token: 'sk-ant-oat01-c' },
    ];

    const withUsage = await checkAllUsage(accounts);
    const best = pickBestAccount(withUsage, 'a'); // Exclude 'a'

    assert.equal(best.account.name, 'b');
  });
});
