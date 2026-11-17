/** Limits that keep a public site from being abused. Server-only. */
import { query } from "./db";

/** Searches (or sign-in attempts) one visitor may make per minute. */
const ACTIONS_PER_MINUTE = 15;
const MINUTE_MS = 60_000;

const recentActions = new Map<string, number[]>();

/**
 * True if this visitor may act now; false if they are going too fast.
 * This is counted in each server's own memory: it stops a burst from one
 * visitor, and with several servers the real limit is this number per server.
 */
export function allowAction(visitor: string): boolean {
  const now = Date.now();
  const times = (recentActions.get(visitor) ?? []).filter((t) => now - t < MINUTE_MS);
  const allowed = times.length < ACTIONS_PER_MINUTE;
  if (allowed) times.push(now);
  recentActions.set(visitor, times);
  // Forget visitors who have been quiet, so the list cannot grow forever.
  if (recentActions.size > 5_000) {
    for (const [key, seen] of recentActions) {
      if (seen.every((t) => now - t >= MINUTE_MS)) recentActions.delete(key);
    }
  }
  return allowed;
}

/**
 * Count one use of something that is limited per day (Amazon searches, newly
 * added stores). Returns false, without counting, once today's limit is used up.
 * The count is kept in the database, so it is shared by all servers and
 * survives restarts.
 */
export async function takeDailyAllowance(name: string, limit: number): Promise<boolean> {
  const counted = await query(
    `insert into daily_counters (name, day, used) values ($1, current_date, 1)
     on conflict (name, day) do update set used = daily_counters.used + 1
       where daily_counters.used < $2::int
     returning used`,
    [name, limit],
  );
  return counted.length > 0;
}
