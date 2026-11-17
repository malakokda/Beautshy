import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Account, AccountRow } from "./plans";

/**
 * What the page can ask the server about accounts. The real work is in
 * accounts.ts, which is loaded inside each handler so it never reaches the browser.
 */

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});

type AuthResponse =
  | { ok: true; account: Account }
  /** The account exists but the email has to be confirmed before signing in. */
  | { ok: true; account?: undefined; message: string }
  | { ok: false; error: string };

/** Slow down password guessing: the same per-minute limit as searching. */
async function tooManyAttempts(): Promise<boolean> {
  const [{ getRequestIP }, { allowAction }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("./rate-limit"),
  ]);
  return !allowAction(`auth:${getRequestIP({ xForwardedFor: true }) ?? "unknown"}`);
}

function authHandler(kind: "signUp" | "signIn") {
  return async ({ data }: { data: z.infer<typeof credentials> }): Promise<AuthResponse> => {
    if (await tooManyAttempts()) {
      return { ok: false, error: "Too many attempts. Please wait a minute and try again." };
    }
    const accounts = await import("./accounts");
    try {
      const result = await accounts[kind](data.email, data.password);
      if (!result.ok) return result;
      if (!result.user) return { ok: true, message: result.message };
      return { ok: true, account: await accounts.getAccount(result.user) };
    } catch (err) {
      console.error(`[accounts] ${kind} failed:`, err);
      return { ok: false, error: "Accounts are not available right now. Please try again later." };
    }
  };
}

export const signUp = createServerFn({ method: "POST" })
  .inputValidator((data) => credentials.parse(data))
  .handler(authHandler("signUp"));

export const signIn = createServerFn({ method: "POST" })
  .inputValidator((data) => credentials.parse(data))
  .handler(authHandler("signIn"));

export const signOut = createServerFn({ method: "POST" }).handler(async (): Promise<null> => {
  (await import("./accounts")).endSession();
  return null;
});

/** The signed-in person's account, or null when nobody is signed in. */
export const getMyAccount = createServerFn({ method: "GET" }).handler(
  async (): Promise<Account | null> => {
    const accounts = await import("./accounts");
    const user = accounts.currentUser();
    return user ? accounts.getAccount(user) : null;
  },
);

/** Ask the owner for premium. Returns the updated account. */
export const requestUpgrade = createServerFn({ method: "POST" }).handler(
  async (): Promise<Account | null> => {
    const accounts = await import("./accounts");
    const user = accounts.currentUser();
    if (!user) return null;
    await accounts.requestUpgrade(user);
    return accounts.getAccount(user);
  },
);

/** Owner only: every account. Other people get an empty list. */
export const adminListAccounts = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccountRow[]> => {
    const accounts = await import("./accounts");
    const user = accounts.currentUser();
    return user && accounts.isAdmin(user.email) ? accounts.listAccounts() : [];
  },
);

/** Owner only: make an account premium or free again. */
export const adminSetPlan = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z.object({ userId: z.string().uuid(), plan: z.enum(["free", "premium"]) }).parse(data),
  )
  .handler(async ({ data }): Promise<AccountRow[]> => {
    const accounts = await import("./accounts");
    const user = accounts.currentUser();
    if (!user || !accounts.isAdmin(user.email)) return [];
    await accounts.setPlan(data.userId, data.plan);
    return accounts.listAccounts();
  });
