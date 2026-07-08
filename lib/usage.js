/**
 * Query the Anthropic OAuth usage API.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Returns five_hour and seven_day utilization percentages (0-100).
 */

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Normalize a utilization value to a 0-100 percentage.
 * Handles both 0.0-1.0 (fraction) and 0-100 (percentage) formats.
 */
export function normalizePercent(value) {
  if (typeof value !== 'number' || isNaN(value)) return 0;
  if (value >= 0 && value <= 1.0) {
    return Math.round(value * 100);
  }
  return Math.round(value);
}

/**
 * Compute the next monthly spend-limit reset instant.
 *
 * Enterprise usage-based orgs reset their spend cap on the calendar-month
 * boundary at 00:00 UTC on the 1st (NOT the subscription anniversary). The
 * OAuth usage API does not expose this datetime, so we compute it locally.
 * The same instant renders as 5:00 PM PDT in summer and 4:00 PM PST in winter
 * — that DST difference is handled at display time via a real IANA zone.
 *
 * Why this is safe to hardcode (researched + cross-validated 2026-06-17):
 * Anthropic's official Spend Limits API doc states verbatim that "monthly spend
 * resets at 00:00 UTC on the first of each calendar month" — a fixed, universal
 * rule, the same for every org, independent of when the subscription started.
 * This is the SPEND/usage-credit reset specifically. Do not conflate it with:
 *   - rolling rate limits (5-hour / 7-day windows), which reset on a per-account
 *     rolling basis, NOT on a calendar or billing boundary; or
 *   - seat-fee billing, which is charged on the contract anniversary, NOT the 1st.
 * The API doc notes `period` is an "open set" (only `monthly` exists today), so
 * if Anthropic ever adds a non-monthly cadence this assumption would need a
 * revisit — which is why the reset is surfaced to users labeled "(computed)".
 *
 * @param {Date} [now] - reference instant (defaults to current time)
 * @returns {Date} first day of the next calendar month at 00:00:00.000 UTC
 */
export function nextMonthlyResetUTC(now = new Date()) {
  // Date.UTC rolls month 12 into the next year automatically.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * Empty/disabled spend fields — merged into every usage result so callers can
 * treat the shape uniformly regardless of meter type.
 */
const NO_SPEND = {
  meterType: 'window',
  spendUsedMinor: null,
  spendLimitMinor: null,
  spendCurrency: null,
  spendExponent: null,
  spendPercent: 0,
  spendResetsAt: null,
};

/**
 * Empty model-scoped (Fable) fields — merged into error/timeout results so the
 * return shape is uniform whether or not a scoped cap was read.
 */
const NO_FABLE = {
  fablePercent: null,
  fableResetsAt: null,
};

/**
 * Detect and normalize a spend-metered (Enterprise usage-based) payload.
 *
 * Precedence: the `spend` block is authoritative; the older `extra_usage`
 * block is the fallback when `spend` is absent. Returns null when the payload
 * is window-metered (no usable spend signal), so the caller keeps existing
 * behavior.
 *
 * Percent is computed locally from used/limit and preferred over the reported
 * `spend.percent`, which has been observed to lag (a transient stale reading
 * returned 100% while used/limit said 65%). A null limit means UNLIMITED and a
 * zero limit means included-only — both yield 0% and are never "exhausted".
 *
 * @param {object} data - raw usage API payload
 * @returns {object|null} normalized spend fields, or null if window-metered
 */
export function parseSpend(data) {
  // A spend block is the PRIMARY meter only when the rolling windows are absent
  // (true Enterprise usage-based orgs return five_hour/seven_day = null). Max and
  // Pro accounts also carry a spend block, but it is just their extra-usage
  // overage cap — their real meter is the rolling window, so we must NOT flip
  // them to spend-metering or we would hide live session/weekly usage.
  const windowMetered = data?.five_hour != null || data?.seven_day != null;
  if (windowMetered) return null;

  const spend = data?.spend;
  const extra = data?.extra_usage;

  let usedMinor = null;
  let limitMinor = null;
  let currency = null;
  let exponent = null;
  let reportedPercent = null;

  if (spend && (spend.used || spend.limit)) {
    usedMinor = typeof spend.used?.amount_minor === 'number' ? spend.used.amount_minor : null;
    limitMinor = typeof spend.limit?.amount_minor === 'number' ? spend.limit.amount_minor : null;
    currency = spend.used?.currency ?? spend.limit?.currency ?? null;
    exponent = spend.used?.exponent ?? spend.limit?.exponent ?? null;
    reportedPercent = typeof spend.percent === 'number' ? spend.percent : null;
  } else if (extra && extra.is_enabled && typeof extra.monthly_limit === 'number') {
    usedMinor = typeof extra.used_credits === 'number' ? Math.round(extra.used_credits) : null;
    limitMinor = extra.monthly_limit;
    currency = extra.currency ?? null;
    exponent = typeof extra.decimal_places === 'number' ? extra.decimal_places : null;
    reportedPercent = typeof extra.utilization === 'number' ? extra.utilization : null;
  } else {
    return null; // window-metered
  }

  let percent;
  if (limitMinor == null || limitMinor === 0) {
    // Unlimited (null) or included-only (0): no meaningful ratio; never over budget.
    percent = 0;
  } else if (usedMinor != null) {
    percent = Math.min(100, normalizePercent((usedMinor / limitMinor) * 100));
  } else {
    // used missing but limit present: fall back to the reported percent.
    percent = normalizePercent(reportedPercent ?? 0);
  }

  return {
    meterType: 'spend',
    spendUsedMinor: usedMinor,
    spendLimitMinor: limitMinor,
    spendCurrency: currency,
    spendExponent: exponent,
    spendPercent: percent,
    spendResetsAt: nextMonthlyResetUTC().toISOString(),
  };
}

/**
 * Extract the model-scoped weekly limit for a given model display name from the
 * usage payload's `limits` array. The API reports per-model weekly caps (e.g.
 * Fable) as entries with kind `weekly_scoped` and `scope.model.display_name`.
 * The older top-level `five_hour`/`seven_day` fields do NOT carry this, so it
 * must be read from `limits`. Returns { percent, resetsAt } or null if absent.
 *
 * @param {object} data - raw usage API payload
 * @param {string} modelName - display name to match (e.g. "Fable")
 * @returns {{ percent: number, resetsAt: string|null }|null}
 */
export function parseScopedModelLimit(data, modelName) {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const entry = limits.find(
    (l) => l?.kind === 'weekly_scoped' && l?.scope?.model?.display_name === modelName
  );
  if (!entry) return null;
  return {
    percent: normalizePercent(entry.percent ?? 0),
    resetsAt: entry.resets_at ?? null,
  };
}

/**
 * Check usage for a single account token.
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{sessionPercent: number, weeklyPercent: number, sessionResetsAt: string|null, weeklyResetsAt: string|null, meterType: string, spendUsedMinor: number|null, spendLimitMinor: number|null, spendCurrency: string|null, spendExponent: number|null, spendPercent: number, spendResetsAt: string|null, error: string|null}>}
 */
export async function checkUsage(token) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        sessionPercent: 0,
        weeklyPercent: 0,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        ...NO_FABLE,
        ...NO_SPEND,
        error: `HTTP ${res.status}`,
      };
    }

    const data = await res.json();

    // Enterprise usage-based orgs are spend-metered: five_hour/seven_day are
    // null and a `spend` (or `extra_usage`) block carries the dollar meter.
    // parseSpend returns null for window-metered accounts, so we fall back to
    // the existing window fields then.
    const spend = parseSpend(data) ?? NO_SPEND;

    // Model-scoped weekly cap (e.g. Fable) lives in data.limits[], not in the
    // top-level five_hour/seven_day fields. Null when the account has no such cap.
    const fable = parseScopedModelLimit(data, 'Fable');
    const fableFields = {
      fablePercent: fable ? fable.percent : null,
      fableResetsAt: fable ? fable.resetsAt : null,
    };

    // New nested format: { five_hour: { utilization: N, resets_at: "..." }, seven_day: { ... } }
    if (data.five_hour !== undefined || data.seven_day !== undefined) {
      return {
        sessionPercent: normalizePercent(data.five_hour?.utilization ?? 0),
        weeklyPercent: normalizePercent(data.seven_day?.utilization ?? 0),
        sessionResetsAt: data.five_hour?.resets_at ?? null,
        weeklyResetsAt: data.seven_day?.resets_at ?? null,
        ...fableFields,
        ...spend,
        error: null,
      };
    }

    // Legacy flat format: { five_hour_utilization: 0.72, ... }
    return {
      sessionPercent: normalizePercent(data.five_hour_utilization ?? 0),
      weeklyPercent: normalizePercent(data.seven_day_utilization ?? 0),
      sessionResetsAt: data.five_hour_reset_at ?? null,
      weeklyResetsAt: data.seven_day_reset_at ?? null,
      ...fableFields,
      ...spend,
      error: null,
    };
  } catch (error) {
    return {
      sessionPercent: 0,
      weeklyPercent: 0,
      sessionResetsAt: null,
      weeklyResetsAt: null,
      ...NO_FABLE,
      ...NO_SPEND,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  }
}

/**
 * Fetch the account profile (name, email) from the OAuth profile API.
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{name: string|null, email: string|null}>}
 */
export async function fetchProfile(token) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) return { name: null, email: null, orgId: null, orgName: null, orgType: null, accountUuid: null };

    const data = await res.json();
    return {
      name: data.account?.full_name || data.account?.display_name || null,
      email: data.account?.email || null,
      // Organization-level identity. One email can belong to multiple orgs —
      // e.g. an enterprise email that, per company policy, has both an
      // enterprise org and a personal Max plan org — each with its own quota
      // and OAuth token. organization.uuid is globally unique, so it — not
      // email — is the correct identity key for account switching.
      orgId: data.organization?.uuid || null,
      orgName: data.organization?.name || null,
      orgType: data.organization?.organization_type || null,
      accountUuid: data.account?.uuid || null,
    };
  } catch {
    return { name: null, email: null, orgId: null, orgName: null, orgType: null, accountUuid: null };
  }
}

/**
 * Check usage for all accounts in parallel.
 *
 * @param {Array<{name: string, configDir: string, token: string}>} accounts
 * @returns {Promise<Array<{name: string, configDir: string, token: string, usage: object}>>}
 */
export async function checkAllUsage(accounts) {
  const results = await Promise.all(
    accounts.map(async (account) => {
      const usage = await checkUsage(account.token);
      return { ...account, usage };
    })
  );
  return results;
}
