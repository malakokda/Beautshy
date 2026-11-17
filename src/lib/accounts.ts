/**
 * Accounts: signing in, the free-search allowance and premium upgrades.
 * Server-only. Passwords are kept by Supabase Auth; each person's plan and
 * search count are in the "profiles" table (see schema.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import { createSupabaseAuthClient } from "@/integrations/supabase/client.server";
import { query } from "./db";
import { FREE_SEARCHES, type Account, type AccountRow } from "./plans";

export type SessionUser = { id: string; email: string };

/* ---------- Staying signed in: a signed cookie ---------- */

const COOKIE = "bdf_session";
const SESSION_DAYS = 30;

function signature(payload: string): string {
  const secret = process.env["SESSION_SECRET"] ?? process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!secret) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** The cookie's text for a user: their details plus a signature nobody else can make. */
export function sessionToken(user: SessionUser, expires: number): string {
  const payload = Buffer.from(JSON.stringify({ ...user, expires })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

/** The user a cookie belongs to, or null when it is missing, altered or expired. */
export function userFromToken(token: string | undefined, now = Date.now()): SessionUser | null {
  const [payload, sig] = token?.split(".") ?? [];
  if (!payload || !sig) return null;
  const expected = Buffer.from(signature(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<
      SessionUser & { expires: number }
    >;
    if (typeof data.id !== "string" || typeof data.email !== "string") return null;
    if (typeof data.expires !== "number" || data.expires < now) return null;
    return { id: data.id, email: data.email };
  } catch {
    return null;
  }
}

function startSession(user: SessionUser): void {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  setCookie(COOKIE, sessionToken(user, Date.now() + maxAge * 1000), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge,
  });
}

export function endSession(): void {
  deleteCookie(COOKIE, { path: "/" });
}

/** The person making this request, or null when they are not signed in. */
export function currentUser(): SessionUser | null {
  return userFromToken(getCookie(COOKIE));
}

/* ---------- Signing up and signing in (Supabase Auth) ---------- */

export type AuthResult =
  | { ok: true; user: SessionUser }
  /** The account was created but the email must be confirmed first. */
  | { ok: true; user?: undefined; message: string }
  | { ok: false; error: string };

function friendly(message: string): string {
  if (/fetch failed|network|ENOTFOUND/i.test(message)) {
    return "The sign-in service cannot be reached right now. Please try again later.";
  }
  if (/invalid login credentials/i.test(message)) return "Wrong email or password.";
  if (/email not confirmed/i.test(message)) {
    return "Please open the confirmation link we emailed you, then sign in.";
  }
  if (/already registered/i.test(message)) {
    return "An account with this email already exists. Sign in instead.";
  }
  if (/rate limit/i.test(message)) return "Too many attempts. Please wait a while and try again.";
  return message;
}

export async function signUp(email: string, password: string): Promise<AuthResult> {
  // A separate client, so the shared one never switches to this person's identity.
  const { data, error } = await createSupabaseAuthClient().signUp({ email, password });
  if (error) return { ok: false, error: friendly(error.message) };
  if (!data.user?.email || data.user.identities?.length === 0) {
    return { ok: false, error: "An account with this email already exists. Sign in instead." };
  }
  if (!data.session) {
    return {
      ok: true,
      message: `We sent a confirmation link to ${email}. Open it, then sign in here.`,
    };
  }
  const user = { id: data.user.id, email: data.user.email };
  startSession(user);
  return { ok: true, user };
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await createSupabaseAuthClient().signInWithPassword({
    email,
    password,
  });
  if (error) return { ok: false, error: friendly(error.message) };
  if (!data.user?.email) return { ok: false, error: "Wrong email or password." };
  const user = { id: data.user.id, email: data.user.email };
  startSession(user);
  return { ok: true, user };
}

/* ---------- Plans and the free-search allowance ---------- */

/** The site owner's emails (ADMIN_EMAILS in .env, separated by commas): unlimited searches. */
export function isAdmin(email: string): boolean {
  return (process.env["ADMIN_EMAILS"] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

type Profile = {
  plan: string;
  searches_used: number;
  upgrade_requested_at: unknown;
};

/** This person's row, created the first time they are seen. */
async function loadProfile(user: SessionUser): Promise<Profile> {
  const rows = await query<Profile>(
    `insert into profiles (user_id, email) values ($1, $2)
     on conflict (user_id) do update set email = excluded.email
     returning plan, searches_used, upgrade_requested_at`,
    [user.id, user.email],
  );
  return rows[0]!;
}

export async function getAccount(user: SessionUser): Promise<Account> {
  const profile = await loadProfile(user);
  const admin = isAdmin(user.email);
  const plan = profile.plan === "premium" ? "premium" : "free";
  const unlimited = admin || plan === "premium";
  return {
    email: user.email,
    plan,
    searchesUsed: profile.searches_used,
    searchesLeft: unlimited ? null : Math.max(0, FREE_SEARCHES - profile.searches_used),
    isAdmin: admin,
    upgradeRequested: profile.upgrade_requested_at !== null,
  };
}

/**
 * Take one search from this person's allowance before the search runs.
 * `refund` gives it back when the search turns out to find nothing.
 *
 * The check and the count are one database statement, so two searches sent at
 * the same moment (even to different servers) cannot both use the last free search.
 */
export async function reserveSearch(
  user: SessionUser,
): Promise<{ allowed: boolean; refund: () => Promise<void> }> {
  await loadProfile(user);
  const counted = await query(
    `update profiles set searches_used = searches_used + 1
      where user_id = $1 and (plan = 'premium' or $2::boolean or searches_used < $3::int)
      returning user_id`,
    [user.id, isAdmin(user.email), FREE_SEARCHES],
  );
  if (counted.length === 0) return { allowed: false, refund: async () => {} };
  return {
    allowed: true,
    refund: async () => {
      await query(
        `update profiles set searches_used = greatest(searches_used - 1, 0) where user_id = $1`,
        [user.id],
      ).catch((err: unknown) => console.error("[accounts] could not refund a search:", err));
    },
  };
}

export async function requestUpgrade(user: SessionUser): Promise<void> {
  await query(
    `update profiles set upgrade_requested_at = now()
      where user_id = $1 and upgrade_requested_at is null`,
    [user.id],
  );
}

/* ---------- For the site owner ---------- */

type AccountRecord = {
  user_id: string;
  email: string;
  plan: string;
  searches_used: number;
  requested_at: string | null;
  created_at: string;
};

/** Every account, with the people waiting for an upgrade first. */
export async function listAccounts(): Promise<AccountRow[]> {
  const rows = await query<AccountRecord>(
    `select user_id, email, plan, searches_used,
            upgrade_requested_at::text as requested_at, created_at::text as created_at
       from profiles
      order by upgrade_requested_at desc nulls last, created_at desc
      limit 500`,
  );
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    plan: row.plan === "premium" ? "premium" : "free",
    searchesUsed: row.searches_used,
    upgradeRequestedAt: row.requested_at,
    createdAt: row.created_at,
  }));
}

/** Switch an account between free and premium (after the owner received payment). */
export async function setPlan(userId: string, plan: "free" | "premium"): Promise<void> {
  await query(`update profiles set plan = $2, upgrade_requested_at = null where user_id = $1`, [
    userId,
    plan,
  ]);
}
