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

const emailOnly = credentials.pick({ email: true });
const emailAndCode = emailOnly.extend({
  code: z
    .string()
    .trim()
    .regex(/^\d{6,10}$/),
});

type AuthResponse =
  | { ok: true; account: Account }
  /** The email has to be confirmed with the emailed code before signing in. */
  | { ok: true; account?: undefined; needsCode: true; message: string }
  | { ok: false; error: string };

/** Sign-in attempts allowed for one email address per 15 minutes, from anywhere. */
const ATTEMPTS_PER_EMAIL = 10;

/**
 * Slow down password and code guessing: 15 attempts a minute per visitor, and
 * 10 per 15 minutes for any one email address, so spreading guesses over many
 * internet addresses does not help either.
 */
async function tooManyAttempts(email: string): Promise<boolean> {
  const { allowAction, visitorAddress } = await import("./rate-limit");
  return (
    !allowAction(`auth:${visitorAddress()}`) ||
    !allowAction(`auth-email:${email}`, ATTEMPTS_PER_EMAIL, 15 * 60_000)
  );
}

type Accounts = typeof import("./accounts");

/** Shared by every sign-in step: the attempt limit, then turning the result into an account. */
async function authStep(
  name: string,
  email: string,
  run: (accounts: Accounts) => ReturnType<Accounts["signIn"]>,
): Promise<AuthResponse> {
  if (await tooManyAttempts(email)) {
    return { ok: false, error: "Too many attempts. Please wait a minute and try again." };
  }
  const accounts = await import("./accounts");
  try {
    const result = await run(accounts);
    if (!result.ok || !result.user) return result;
    return { ok: true, account: await accounts.getAccount(result.user) };
  } catch (err) {
    console.error(`[accounts] ${name} failed:`, err);
    return { ok: false, error: "Accounts are not available right now. Please try again later." };
  }
}

export const signUp = createServerFn({ method: "POST" })
  .inputValidator((data) => credentials.parse(data))
  .handler(({ data }) =>
    authStep("signUp", data.email, (a) => a.signUp(data.email, data.password)),
  );

export const signIn = createServerFn({ method: "POST" })
  .inputValidator((data) => credentials.parse(data))
  .handler(({ data }) =>
    authStep("signIn", data.email, (a) => a.signIn(data.email, data.password)),
  );

/** Confirm the email with the emailed code; signs the person in. */
export const verifyCode = createServerFn({ method: "POST" })
  .inputValidator((data) => emailAndCode.parse(data))
  .handler(({ data }) =>
    authStep("verifyCode", data.email, (a) => a.verifyCode(data.email, data.code)),
  );

/** Email a new code. */
export const resendCode = createServerFn({ method: "POST" })
  .inputValidator((data) => emailOnly.parse(data))
  .handler(({ data }) => authStep("resendCode", data.email, (a) => a.resendCode(data.email)));

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

/**
 * Start paying for premium by card: returns the address of Paymob's checkout
 * page for the page to open. The price is set on the server (plans.ts).
 */
export const startPayment = createServerFn({ method: "POST" })
  .inputValidator((data) => z.object({ phone: z.string().trim().max(20) }).parse(data))
  .handler(
    async ({ data }): Promise<{ ok: true; checkoutUrl: string } | { ok: false; error: string }> => {
      const [accounts, payments, { allowAction, visitorAddress }] = await Promise.all([
        import("./accounts"),
        import("./payments"),
        import("./rate-limit"),
      ]);
      const user = accounts.currentUser();
      if (!user) return { ok: false, error: "Please sign in first." };
      if (!allowAction(`pay:${visitorAddress()}`, 5, 10 * 60_000)) {
        return { ok: false, error: "Too many attempts. Please wait a few minutes and try again." };
      }
      const phone = payments.egyptianMobile(data.phone);
      if (!phone) {
        return { ok: false, error: "Please enter an Egyptian mobile number, e.g. 01012345678." };
      }
      try {
        return await payments.startCardPayment(user, phone);
      } catch (err) {
        console.error("[payments] could not start a payment:", err);
        return { ok: false, error: "The payment could not be started. Please try again later." };
      }
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
