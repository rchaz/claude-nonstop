import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePercent, checkUsage, fetchProfile, checkAllUsage, nextMonthlyResetUTC, parseScopedModelLimit } from '../../../lib/usage.js';

describe('normalizePercent', () => {
  it('converts 0.5 fraction to 50%', () => {
    assert.equal(normalizePercent(0.5), 50);
  });

  it('converts 0.72 fraction to 72%', () => {
    assert.equal(normalizePercent(0.72), 72);
  });

  it('keeps 75 as 75 (already a percentage)', () => {
    assert.equal(normalizePercent(75), 75);
  });

  it('keeps 100 as 100', () => {
    assert.equal(normalizePercent(100), 100);
  });

  it('returns 0 for NaN', () => {
    assert.equal(normalizePercent(NaN), 0);
  });

  it('returns 0 for non-number', () => {
    assert.equal(normalizePercent('hello'), 0);
    assert.equal(normalizePercent(null), 0);
    assert.equal(normalizePercent(undefined), 0);
  });

  it('handles 0', () => {
    assert.equal(normalizePercent(0), 0);
  });

  it('handles 1.0 as 100%', () => {
    assert.equal(normalizePercent(1.0), 100);
  });

  it('rounds negative values', () => {
    assert.equal(normalizePercent(-5), -5);
  });

  it('rounds fractional percentages', () => {
    assert.equal(normalizePercent(0.333), 33);
  });
});

describe('checkUsage', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses new nested format', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 0.42, resets_at: '2026-02-15T12:00:00Z' },
        seven_day: { utilization: 0.75, resets_at: '2026-02-20T00:00:00Z' },
      }),
    });

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.sessionPercent, 42);
    assert.equal(result.weeklyPercent, 75);
    assert.equal(result.sessionResetsAt, '2026-02-15T12:00:00Z');
    assert.equal(result.weeklyResetsAt, '2026-02-20T00:00:00Z');
    assert.equal(result.error, null);
  });

  it('parses legacy flat format', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        five_hour_utilization: 0.30,
        seven_day_utilization: 0.60,
        five_hour_reset_at: '2026-02-15T12:00:00Z',
        seven_day_reset_at: '2026-02-20T00:00:00Z',
      }),
    });

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.sessionPercent, 30);
    assert.equal(result.weeklyPercent, 60);
    assert.equal(result.error, null);
  });

  it('returns error for HTTP errors', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
    });

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.error, 'HTTP 401');
    assert.equal(result.sessionPercent, 0);
  });

  it('returns timeout error on AbortError', async () => {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.error, 'timeout');
  });

  it('returns error message for other errors', async () => {
    globalThis.fetch = async () => {
      throw new Error('Network failure');
    };

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.error, 'Network failure');
  });

  it('defaults window accounts to meterType "window" with null spend fields', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 0.42 },
        seven_day: { utilization: 0.75 },
      }),
    });
    const r = await checkUsage('sk-ant-oat01-test');
    assert.equal(r.meterType, 'window');
    assert.equal(r.spendPercent, 0);
    assert.equal(r.spendLimitMinor, null);
    assert.equal(r.spendUsedMinor, null);
    assert.equal(r.spendResetsAt, null);
  });

  it('extracts Fable-scoped weekly cap from limits[]', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 0, resets_at: '2026-07-09T03:30:00Z' },
        seven_day: { utilization: 4, resets_at: '2026-07-14T19:00:00Z' },
        limits: [
          { kind: 'session', percent: 0, resets_at: '2026-07-09T03:30:00Z' },
          { kind: 'weekly_all', percent: 4, resets_at: '2026-07-14T19:00:00Z' },
          { kind: 'weekly_scoped', percent: 100, resets_at: '2026-07-12T19:00:00Z', scope: { model: { display_name: 'Fable' } } },
        ],
      }),
    });
    const r = await checkUsage('sk-ant-oat01-test');
    assert.equal(r.fablePercent, 100);
    assert.equal(r.fableResetsAt, '2026-07-12T19:00:00Z');
  });

  it('leaves Fable fields null when no scoped cap present', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 0 },
        seven_day: { utilization: 4 },
        limits: [{ kind: 'weekly_all', percent: 4 }],
      }),
    });
    const r = await checkUsage('sk-ant-oat01-test');
    assert.equal(r.fablePercent, null);
    assert.equal(r.fableResetsAt, null);
  });
});

describe('parseScopedModelLimit', () => {
  const withFable = {
    limits: [
      { kind: 'weekly_all', percent: 29, resets_at: '2026-07-10T03:00:00Z' },
      { kind: 'weekly_scoped', percent: 58, resets_at: '2026-07-10T03:00:00Z', scope: { model: { display_name: 'Fable' } } },
    ],
  };

  it('returns percent + resetsAt for a matching scoped model', () => {
    const r = parseScopedModelLimit(withFable, 'Fable');
    assert.deepEqual(r, { percent: 58, resetsAt: '2026-07-10T03:00:00Z' });
  });

  it('returns null when the model is not present', () => {
    assert.equal(parseScopedModelLimit(withFable, 'Opus'), null);
  });

  it('returns null when limits is absent or empty', () => {
    assert.equal(parseScopedModelLimit({}, 'Fable'), null);
    assert.equal(parseScopedModelLimit({ limits: [] }, 'Fable'), null);
    assert.equal(parseScopedModelLimit(null, 'Fable'), null);
  });

  it('normalizes a fractional percent and tolerates a null reset', () => {
    const data = { limits: [{ kind: 'weekly_scoped', percent: 0.42, scope: { model: { display_name: 'Fable' } } }] };
    assert.deepEqual(parseScopedModelLimit(data, 'Fable'), { percent: 42, resetsAt: null });
  });

  it('ignores non-weekly_scoped entries that name the model', () => {
    const data = { limits: [{ kind: 'session', percent: 99, scope: { model: { display_name: 'Fable' } } }] };
    assert.equal(parseScopedModelLimit(data, 'Fable'), null);
  });
});

describe('checkUsage — spend-metered (Enterprise) accounts', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // Real Enterprise payload shape observed on the live Speak org.
  const enterprisePayload = (overrides = {}) => ({
    five_hour: null,
    seven_day: null,
    extra_usage: {
      is_enabled: true,
      monthly_limit: 100000,
      used_credits: 64913.0,
      utilization: 64.913,
      currency: 'USD',
      decimal_places: 2,
      ...(overrides.extra_usage || {}),
    },
    spend: overrides.spend === null ? undefined : {
      used: { amount_minor: 64913, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 100000, currency: 'USD', exponent: 2 },
      percent: 65,
      severity: 'normal',
      enabled: true,
      disabled_reason: null,
      ...(overrides.spend || {}),
    },
  });

  const stub = (payload) => { globalThis.fetch = async () => ({ ok: true, json: async () => payload }); };

  it('parses the spend block into normalized dollar fields', async () => {
    stub(enterprisePayload());
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.meterType, 'spend');
    assert.equal(r.spendUsedMinor, 64913);
    assert.equal(r.spendLimitMinor, 100000);
    assert.equal(r.spendCurrency, 'USD');
    assert.equal(r.spendExponent, 2);
    // computed from used/limit: 64913/100000 = 64.913 -> 65
    assert.equal(r.spendPercent, 65);
    // window fields stay zero for a spend account
    assert.equal(r.sessionPercent, 0);
    assert.equal(r.weeklyPercent, 0);
    assert.equal(r.error, null);
  });

  it('emits a computed monthly spendResetsAt (next 1st of month, 00:00 UTC)', async () => {
    stub(enterprisePayload());
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.ok(r.spendResetsAt, 'spendResetsAt should be set');
    const d = new Date(r.spendResetsAt);
    assert.equal(d.getUTCDate(), 1);
    assert.equal(d.getUTCHours(), 0);
    assert.equal(d.getUTCMinutes(), 0);
    assert.ok(d.getTime() > Date.now(), 'reset is in the future');
  });

  it('prefers COMPUTED percent over a stale reported spend.percent', async () => {
    // Simulate the transient stale reading we actually observed: percent=100 but used/limit say 65%.
    stub(enterprisePayload({ spend: { percent: 100, severity: 'critical' } }));
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.spendPercent, 65); // trusts used/limit, not the stale percent
  });

  it('falls back to extra_usage when the spend block has no used/limit amounts', async () => {
    // A spend block with null used+limit carries no dollar signal, so the
    // older extra_usage block (still populated) is used instead.
    stub(enterprisePayload({ spend: { used: null, limit: null, percent: 42 } }));
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.meterType, 'spend');
    assert.equal(r.spendUsedMinor, 64913);   // from extra_usage.used_credits
    assert.equal(r.spendLimitMinor, 100000); // from extra_usage.monthly_limit
    assert.equal(r.spendPercent, 65);
  });

  it('uses reported percent when limit is present but used amount is missing', async () => {
    // spend block has a limit (so it is the authoritative source) but no used
    // amount; we cannot compute a ratio, so we trust the reported percent.
    stub(enterprisePayload({
      spend: {
        used: null,
        limit: { amount_minor: 100000, currency: 'USD', exponent: 2 },
        percent: 42,
      },
    }));
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.spendLimitMinor, 100000);
    assert.equal(r.spendUsedMinor, null);
    assert.equal(r.spendPercent, 42);
  });

  it('treats null limit as UNLIMITED (percent 0, never exhausted)', async () => {
    stub(enterprisePayload({ spend: { limit: null } }));
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.meterType, 'spend');
    assert.equal(r.spendLimitMinor, null);
    assert.equal(r.spendPercent, 0);
  });

  it('treats zero limit as included-only (percent 0, not over budget)', async () => {
    stub(enterprisePayload({ spend: { limit: { amount_minor: 0, currency: 'USD', exponent: 2 } } }));
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.spendLimitMinor, 0);
    assert.equal(r.spendPercent, 0);
  });

  it('clamps spendPercent to 100 when used exceeds limit', async () => {
    stub(enterprisePayload({
      spend: {
        used: { amount_minor: 150000, currency: 'USD', exponent: 2 },
        limit: { amount_minor: 100000, currency: 'USD', exponent: 2 },
        percent: 100,
      },
    }));
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.spendPercent, 100);
    assert.equal(r.spendUsedMinor, 150000);
  });

  it('carries a non-USD currency and non-2 exponent through', async () => {
    stub(enterprisePayload({
      spend: {
        used: { amount_minor: 5000, currency: 'JPY', exponent: 0 },
        limit: { amount_minor: 20000, currency: 'JPY', exponent: 0 },
        percent: 25,
      },
    }));
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.spendCurrency, 'JPY');
    assert.equal(r.spendExponent, 0);
    assert.equal(r.spendPercent, 25);
  });

  it('falls back to extra_usage block when spend block is absent', async () => {
    stub(enterprisePayload({ spend: null }));
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.meterType, 'spend');
    assert.equal(r.spendUsedMinor, 64913);   // from used_credits
    assert.equal(r.spendLimitMinor, 100000); // from monthly_limit
    assert.equal(r.spendPercent, 65);
  });

  it('stays window-metered when extra_usage is disabled and no spend block', async () => {
    stub({
      five_hour: { utilization: 0.1 },
      seven_day: { utilization: 0.2 },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0 },
    });
    const r = await checkUsage('sk-ant-oat01-test');
    assert.equal(r.meterType, 'window');
    assert.equal(r.spendPercent, 0);
  });

  it('Max/Pro accounts keep WINDOW metering even though they carry a spend (overage) block', async () => {
    // Real Max payload: live rolling-window usage AND an extra-usage overage cap.
    // The window is the governing meter; the spend block is just the overage
    // ceiling and must not hide the real session/weekly usage.
    stub({
      five_hour: { utilization: 14, resets_at: '2026-06-17T02:30:00Z' },
      seven_day: { utilization: 5, resets_at: '2026-06-23T19:00:00Z' },
      spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 },
               limit: { amount_minor: 2000, currency: 'USD', exponent: 2 },
               percent: 0, severity: 'normal', enabled: true },
      extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 0, currency: 'USD', decimal_places: 2 },
    });
    const r = await checkUsage('sk-ant-oat01-max');
    assert.equal(r.meterType, 'window');     // NOT spend
    assert.equal(r.sessionPercent, 14);       // real window usage preserved
    assert.equal(r.weeklyPercent, 5);
    assert.equal(r.spendPercent, 0);
    assert.equal(r.spendLimitMinor, null);    // spend fields stay neutral for window accounts
  });

  it('Enterprise stays spend-metered when both windows are explicitly null', async () => {
    stub(enterprisePayload());
    const r = await checkUsage('sk-ant-oat01-ent');
    assert.equal(r.meterType, 'spend');
    assert.equal(r.spendPercent, 65);
  });
});

describe('nextMonthlyResetUTC', () => {
  it('returns the 1st of next month at 00:00:00 UTC (mid-month)', () => {
    const reset = nextMonthlyResetUTC(new Date('2026-06-16T17:00:00Z'));
    assert.equal(reset.toISOString(), '2026-07-01T00:00:00.000Z');
  });

  it('handles the last day of the month', () => {
    const reset = nextMonthlyResetUTC(new Date('2026-06-30T23:59:59Z'));
    assert.equal(reset.toISOString(), '2026-07-01T00:00:00.000Z');
  });

  it('rolls the year over December -> January', () => {
    const reset = nextMonthlyResetUTC(new Date('2026-12-15T10:00:00Z'));
    assert.equal(reset.toISOString(), '2027-01-01T00:00:00.000Z');
  });

  it('handles leap-year February correctly', () => {
    const reset = nextMonthlyResetUTC(new Date('2028-02-15T00:00:00Z'));
    assert.equal(reset.toISOString(), '2028-03-01T00:00:00.000Z');
  });

  it('handles an instant exactly at a month boundary (00:00 on the 1st)', () => {
    // At 00:00 on the 1st, the next reset is the 1st of the FOLLOWING month.
    const reset = nextMonthlyResetUTC(new Date('2026-06-01T00:00:00Z'));
    assert.equal(reset.toISOString(), '2026-07-01T00:00:00.000Z');
  });
});

describe('fetchProfile', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('extracts name and email', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        account: { full_name: 'Test User', email: 'test@example.com' },
      }),
    });

    const result = await fetchProfile('sk-ant-oat01-test');
    assert.equal(result.name, 'Test User');
    assert.equal(result.email, 'test@example.com');
  });

  it('returns nulls on error', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
    });

    const result = await fetchProfile('sk-ant-oat01-test');
    assert.equal(result.name, null);
    assert.equal(result.email, null);
  });

  it('returns nulls on network error', async () => {
    globalThis.fetch = async () => { throw new Error('fail'); };

    const result = await fetchProfile('sk-ant-oat01-test');
    assert.equal(result.name, null);
    assert.equal(result.email, null);
  });

  it('uses display_name fallback', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        account: { display_name: 'Display Name', email: 'test@example.com' },
      }),
    });

    const result = await fetchProfile('sk-ant-oat01-test');
    assert.equal(result.name, 'Display Name');
  });

  it('extracts organization identity (uuid, name, type) and account uuid', async () => {
    // Real shape returned by api.anthropic.com/api/oauth/profile for an
    // enterprise email account that has both an enterprise org and a personal
    // Max plan org under the same email, per company policy.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        account: { uuid: 'acct-123', full_name: 'Alice Example', email: 'alice@example.com', has_claude_max: true },
        organization: { uuid: 'org-ent-uuid', name: 'Acme Corp', organization_type: 'claude_enterprise' },
      }),
    });

    const r = await fetchProfile('sk-ant-oat01-test');
    assert.equal(r.email, 'alice@example.com');
    assert.equal(r.orgId, 'org-ent-uuid');
    assert.equal(r.orgName, 'Acme Corp');
    assert.equal(r.orgType, 'claude_enterprise');
    assert.equal(r.accountUuid, 'acct-123');
  });

  it('distinguishes two orgs under the SAME email by orgId', async () => {
    const byOrg = {
      'sk-ant-oat01-max': {
        account: { uuid: 'acct-1', email: 'alice@example.com' },
        organization: { uuid: 'org-max', name: 'Personal', organization_type: 'claude_max' },
      },
      'sk-ant-oat01-ent': {
        account: { uuid: 'acct-1', email: 'alice@example.com' },
        organization: { uuid: 'org-ent', name: 'Acme Corp', organization_type: 'claude_enterprise' },
      },
    };
    globalThis.fetch = async (_url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      return { ok: true, json: async () => byOrg[token] };
    };

    const max = await fetchProfile('sk-ant-oat01-max');
    const ent = await fetchProfile('sk-ant-oat01-ent');
    // Same email, same account uuid — but DIFFERENT org identity.
    assert.equal(max.email, ent.email);
    assert.equal(max.accountUuid, ent.accountUuid);
    assert.notEqual(max.orgId, ent.orgId);
  });

  it('returns null org fields when organization is absent (email-only fallback)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ account: { email: 'solo@example.com', full_name: 'Solo' } }),
    });
    const r = await fetchProfile('sk-ant-oat01-test');
    assert.equal(r.orgId, null);
    assert.equal(r.orgName, null);
    assert.equal(r.email, 'solo@example.com');
  });

  it('returns null org fields on HTTP error and on network error', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    let r = await fetchProfile('sk-ant-oat01-test');
    assert.equal(r.orgId, null);
    assert.equal(r.orgName, null);

    globalThis.fetch = async () => { throw new Error('net'); };
    r = await fetchProfile('sk-ant-oat01-test');
    assert.equal(r.orgId, null);
    assert.equal(r.accountUuid, null);
  });
});

describe('checkAllUsage', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('checks all accounts in parallel and preserves order', async () => {
    // Use token to deterministically map to different data (avoids race on shared counter)
    const usageByToken = {
      'sk-ant-oat01-a': { five_hour: { utilization: 0.20 }, seven_day: { utilization: 0.10 } },
      'sk-ant-oat01-b': { five_hour: { utilization: 0.60 }, seven_day: { utilization: 0.40 } },
    };

    globalThis.fetch = async (_url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      return {
        ok: true,
        json: async () => usageByToken[token] || {},
      };
    };

    const accounts = [
      { name: 'a', configDir: '/tmp/a', token: 'sk-ant-oat01-a' },
      { name: 'b', configDir: '/tmp/b', token: 'sk-ant-oat01-b' },
    ];

    const results = await checkAllUsage(accounts);
    assert.equal(results.length, 2);
    // Order is preserved
    assert.equal(results[0].name, 'a');
    assert.equal(results[1].name, 'b');
    // Deterministic values based on token
    assert.equal(results[0].usage.sessionPercent, 20);
    assert.equal(results[0].usage.weeklyPercent, 10);
    assert.equal(results[1].usage.sessionPercent, 60);
    assert.equal(results[1].usage.weeklyPercent, 40);
    assert.equal(results[0].usage.error, null);
    assert.equal(results[1].usage.error, null);
  });
});
