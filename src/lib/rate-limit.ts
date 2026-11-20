/** Limits that keep a public site from being abused. Server-only. */
import { getRequestHeader, getRequestIP } from "@tanstack/react-start/server";
import { query } from "./db";

/** Searches (or sign-in attempts) one visitor may make per minute. */
const ACTIONS_PER_MINUTE = 15;
const MINUTE_MS = 60_000;
/** Kept short of memory: past this many keys, quiet ones are forgotten. */
const MAX_KEYS = 20_000;

const recentActions = new Map<string, number[]>();

/**
 * The internet address of the person making this request.
 *
 * Not the X-Forwarded-For header: anyone can send that with any value, and
 * the host only adds to it, so it would let one person pretend to be many
 * (this was tested on the live site). The site is behind Cloudflare, which
 * sets CF-Connecting-IP itself. Without Cloudflare (on your own computer) the
 * address of the connection is used.
 */
export function visitorAddress(): string {
  return getRequestHeader("cf-connecting-ip")?.trim() || getRequestIP() || "unknown";
}

/**
 * True if `key` may act now; false if it has acted `limit` times in the last
 * `windowMs`. Counted in this server's memory: it stops bursts, and with
 * several servers the real limit is this number per server.
 */
export function allowAction(
  key: string,
  limit = ACTIONS_PER_MINUTE,
  windowMs = MINUTE_MS,
): boolean {
  const now = Date.now();
  const times = (recentActions.get(key) ?? []).filter((t) => now - t < windowMs);
  const allowed = times.length < limit;
  if (allowed) times.push(now);
  recentActions.set(key, times);
  // Forget keys that have been quiet, so the list cannot grow forever.
  if (recentActions.size > MAX_KEYS) {
    for (const [k, seen] of recentActions) {
      if (seen.every((t) => now - t >= 15 * MINUTE_MS)) recentActions.delete(k);
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
