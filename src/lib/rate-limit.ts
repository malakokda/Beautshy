/**
 * Limits that keep a public site from being abused. They are counted in
 * memory, so they start again from zero whenever the server restarts.
 */

/** Searches one visitor may run per minute. */
const SEARCHES_PER_MINUTE = 15;
const MINUTE_MS = 60_000;

const recentSearches = new Map<string, number[]>();

/** True if this visitor may search now; false if they are searching too fast. */
export function allowSearch(visitor: string): boolean {
  const now = Date.now();
  const times = (recentSearches.get(visitor) ?? []).filter((t) => now - t < MINUTE_MS);
  const allowed = times.length < SEARCHES_PER_MINUTE;
  if (allowed) times.push(now);
  recentSearches.set(visitor, times);
  // Forget visitors who have been quiet, so the list cannot grow forever.
  if (recentSearches.size > 5_000) {
    for (const [key, seen] of recentSearches) {
      if (seen.every((t) => now - t >= MINUTE_MS)) recentSearches.delete(key);
    }
  }
  return allowed;
}

const dailyCounts = new Map<string, { day: string; used: number }>();

/**
 * Count one use of something that is limited per day (Amazon searches, newly
 * added stores). Returns false, without counting, once today's limit is used up.
 */
export function takeDailyAllowance(name: string, limit: number): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const count = dailyCounts.get(name);
  if (!count || count.day !== day) {
    dailyCounts.set(name, { day, used: 1 });
    return limit >= 1;
  }
  if (count.used >= limit) return false;
  count.used++;
  return true;
}
