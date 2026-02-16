/**
 * Account scoring and selection.
 *
 * Picks the best account based on usage — lowest effective utilization wins.
 * Effective utilization = max(sessionPercent, weeklyPercent) so we avoid
 * accounts that are near either limit.
 */

/**
 * Pick the best account from a list of accounts with usage data.
 *
 * @param {Array<{name: string, configDir: string, token: string, usage: object}>} accounts
 * @param {string} [excludeName] - Account name to exclude (e.g., the one that just hit a limit)
 * @returns {{ account: object, reason: string } | null}
 */
export function pickBestAccount(accounts, excludeName) {
  const candidates = accounts.filter(a => {
    if (a.name === excludeName) return false;
    if (!a.token) return false;
    if (a.usage?.error) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Sort by effective utilization (ascending — lowest usage first)
  candidates.sort((a, b) => {
    const aUtil = effectiveUtilization(a.usage);
    const bUtil = effectiveUtilization(b.usage);
    return aUtil - bUtil;
  });

  const best = candidates[0];

  return {
    account: best,
    reason: `lowest utilization (session: ${best.usage.sessionPercent}%, weekly: ${best.usage.weeklyPercent}%)`,
  };
}

/**
 * Calculate effective utilization — the higher of session or weekly.
 */
export function effectiveUtilization(usage) {
  if (!usage) return 100;
  return Math.max(usage.sessionPercent || 0, usage.weeklyPercent || 0);
}

