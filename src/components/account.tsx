import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  adminListAccounts,
  adminSetPlan,
  requestUpgrade,
  resendCode,
  signIn,
  signOut,
  signUp,
  startPayment,
  verifyCode,
} from "@/lib/account.functions";
import { isAllowedEmail, NOT_ALLOWED_MESSAGE, suggestEmail } from "@/lib/email-check";
import {
  FREE_SEARCHES,
  PREMIUM_DAYS,
  PREMIUM_PRICE_EGP,
  type Account,
  type AccountRow,
} from "@/lib/plans";

const inputClass =
  "w-full rounded-lg border border-input bg-background px-4 py-3 text-base outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/30";
const primaryButton =
  "rounded-lg bg-primary px-6 py-3 text-base font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";

const linkButton = "font-semibold text-primary underline-offset-2 hover:underline";

type AuthResponse = Awaited<ReturnType<typeof signIn>>;

/** Shown instead of the search box until the visitor signs in or creates an account. */
export function AuthCard({ onSignedIn }: { onSignedIn: (account: Account) => void }) {
  const signInFn = useServerFn(signIn);
  const signUpFn = useServerFn(signUp);
  const verifyCodeFn = useServerFn(verifyCode);
  const resendCodeFn = useServerFn(resendCode);
  const [mode, setMode] = useState<"signIn" | "signUp" | "code">("signUp");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  /** A corrected address offered to the visitor ("Did you mean ...?"). */
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const run = async (call: () => Promise<AuthResponse>, invalidInput: string) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const res = await call();
      if (!res.ok) setError(res.error);
      else if (res.account) onSignedIn(res.account);
      else {
        setMessage(res.message);
        setMode("code");
        setCode("");
      }
    } catch {
      setError(invalidInput);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "code") {
      await run(
        () => verifyCodeFn({ data: { email, code } }),
        "Please enter the code from the email (numbers only).",
      );
      return;
    }
    if (mode === "signUp") {
      const typed = email.trim();
      const likely = suggestEmail(typed);
      if (likely) {
        setSuggestion(likely);
        return;
      }
      if (!isAllowedEmail(typed)) {
        setError(NOT_ALLOWED_MESSAGE);
        return;
      }
    }
    await run(
      () => (mode === "signIn" ? signInFn : signUpFn)({ data: { email, password } }),
      "Please enter a valid email and a password of at least 8 characters.",
    );
  };

  const switchTo = (next: "signIn" | "signUp") => {
    setMode(next);
    setError(undefined);
    setMessage(undefined);
    setSuggestion(null);
  };

  if (mode === "code") {
    return (
      <div>
        <h2 className="font-display text-2xl font-semibold">Confirm your email</h2>
        {message && (
          <p role="status" className="mt-2 text-sm font-semibold text-primary">
            {message}
          </p>
        )}
        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          <input
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6,10}"
            maxLength={10}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="Code from the email"
            aria-label="Code from the email"
            className={`${inputClass} text-center text-2xl tracking-[0.4em]`}
          />
          <button type="submit" disabled={busy} className={`${primaryButton} w-full`}>
            {busy ? "Please wait…" : "Confirm"}
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-3 text-sm font-semibold text-destructive">
            {error}
          </p>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          No email? Check your spam folder, or{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => resendCodeFn({ data: { email } }), "Please check the email address.")
            }
            className={linkButton}
          >
            send a new code
          </button>
          . Wrong address?{" "}
          <button type="button" onClick={() => switchTo("signUp")} className={linkButton}>
            Start again
          </button>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="font-display text-2xl font-semibold">
        {mode === "signUp" ? "Create a free account to search" : "Sign in to search"}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A free account includes {FREE_SEARCHES} searches. Premium is unlimited for EGP{" "}
        {PREMIUM_PRICE_EGP} a month.
        {mode === "signUp" && " Sign up with a Gmail, Yahoo, iCloud or Hotmail address."}
      </p>

      <form onSubmit={onSubmit} className="mt-5 space-y-3">
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setSuggestion(null);
          }}
          placeholder="Email address"
          aria-label="Email address"
          className={inputClass}
        />
        {suggestion && (
          <div
            role="alert"
            className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
          >
            <p>
              Did you mean <span className="font-semibold">{suggestion}</span>?
            </p>
            <button
              type="button"
              onClick={() => {
                setEmail(suggestion);
                setSuggestion(null);
              }}
              className={`${linkButton} mt-2`}
            >
              Yes, use it
            </button>
          </div>
        )}
        <input
          type="password"
          required
          minLength={8}
          autoComplete={mode === "signUp" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (at least 8 characters)"
          aria-label="Password"
          className={inputClass}
        />
        <button type="submit" disabled={busy} className={`${primaryButton} w-full`}>
          {busy ? "Please wait…" : mode === "signUp" ? "Create account" : "Sign in"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm font-semibold text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm font-semibold text-primary">
          {message}
        </p>
      )}

      <p className="mt-4 text-sm text-muted-foreground">
        {mode === "signUp" ? "Already have an account?" : "New here?"}{" "}
        <button
          type="button"
          onClick={() => switchTo(mode === "signUp" ? "signIn" : "signUp")}
          className={linkButton}
        >
          {mode === "signUp" ? "Sign in" : "Create a free account"}
        </button>
      </p>
    </div>
  );
}

/** "2026-12-17T10:00:00+00:00" -> "17 Dec 2026" */
function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value.slice(0, 10)
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** One line above the search box: who is signed in and what they have left. */
export function AccountBar({
  account,
  onSignedOut,
}: {
  account: Account;
  onSignedOut: () => void;
}) {
  const signOutFn = useServerFn(signOut);
  const status = account.isAdmin
    ? "Owner · unlimited searches"
    : account.plan === "premium"
      ? `Premium · unlimited searches${account.premiumUntil ? ` until ${shortDate(account.premiumUntil)}` : ""}`
      : `Free plan · ${account.searchesLeft} of ${FREE_SEARCHES} searches left`;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="min-w-0 truncate text-muted-foreground">
        <span className="font-semibold text-foreground">{account.email}</span> · {status}
      </span>
      <button
        type="button"
        onClick={() => void signOutFn().then(onSignedOut)}
        className="font-semibold text-primary underline-offset-2 hover:underline"
      >
        Sign out
      </button>
    </div>
  );
}

/**
 * Opens by itself over the page when the free searches run out. "Not now"
 * (or Esc) closes it; the same offer stays on the page as an UpgradeCard.
 */
export function UpgradeDialog({
  account,
  open,
  onClose,
  onChanged,
}: {
  account: Account;
  open: boolean;
  onClose: () => void;
  onChanged: (account: Account) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-label="Upgrade to premium"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/50"
    >
      <UpgradeCard account={account} onChanged={onChanged} onDismiss={onClose} />
    </dialog>
  );
}

export function UpgradeCard({
  account,
  onChanged,
  onDismiss,
}: {
  account: Account;
  onChanged: (account: Account) => void;
  /** When given, a "Not now" button is shown (used inside the pop-up). */
  onDismiss?: () => void;
}) {
  const requestUpgradeFn = useServerFn(requestUpgrade);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const onRequest = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const updated = await requestUpgradeFn();
      if (updated) onChanged(updated);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/5 p-8 text-center">
      <p className="text-xs font-bold uppercase tracking-[0.3em] text-primary/70">Premium</p>
      <h2 className="mt-3 font-display text-2xl font-semibold">
        You&apos;ve used your {FREE_SEARCHES} free searches
      </h2>
      <p className="mt-3 font-display text-4xl font-bold text-primary">
        EGP {PREMIUM_PRICE_EGP}
        <span className="text-base font-semibold text-muted-foreground"> / month</span>
      </p>
      <ul className="mx-auto mt-4 max-w-sm space-y-1 text-sm text-muted-foreground">
        <li>Unlimited price searches</li>
        <li>Every store, including Amazon Egypt</li>
        <li>Search by product name or by link</li>
      </ul>
      {account.cardPayments ? (
        <CardPayment />
      ) : account.upgradeRequested ? (
        <p role="status" className="mt-6 text-sm font-semibold text-primary">
          Your upgrade request was received. We will email {account.email} with the payment details
          and switch your account to premium once it is paid.
        </p>
      ) : (
        <button
          type="button"
          onClick={onRequest}
          disabled={busy}
          className={`${primaryButton} mt-6`}
        >
          {busy ? "Sending…" : "Request premium"}
        </button>
      )}
      {failed && (
        <p role="alert" className="mt-3 text-sm font-semibold text-destructive">
          The request could not be sent. Please try again.
        </p>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="mt-4 block w-full text-sm font-semibold text-muted-foreground underline-offset-2 hover:underline"
        >
          Not now
        </button>
      )}
    </div>
  );
}

/**
 * Pay by debit or credit card. The card is typed on Paymob's own page, never
 * on this site; Paymob only needs a mobile number from here.
 */
function CardPayment() {
  const startPaymentFn = useServerFn(startPayment);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const onPay = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await startPaymentFn({ data: { phone } });
      if (res.ok) {
        window.location.assign(res.checkoutUrl); // Paymob's secure payment page
        return; // keep the button busy while the page changes
      }
      setError(res.error);
    } catch {
      setError("The payment could not be started. Please try again.");
    }
    setBusy(false);
  };

  return (
    <form onSubmit={onPay} className="mx-auto mt-6 max-w-xs space-y-3 text-left">
      <input
        type="tel"
        required
        inputMode="tel"
        autoComplete="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="Mobile number, e.g. 01012345678"
        aria-label="Mobile number"
        className={inputClass}
      />
      <button type="submit" disabled={busy} className={`${primaryButton} w-full`}>
        {busy ? "Opening the payment page…" : `Pay EGP ${PREMIUM_PRICE_EGP} by card`}
      </button>
      <p className="text-center text-xs text-muted-foreground">
        Debit or credit card, on Paymob&apos;s secure page. Premium starts as soon as the payment
        goes through and lasts {PREMIUM_DAYS} days.
      </p>
      {error && (
        <p role="alert" className="text-center text-sm font-semibold text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/** The owner's list of accounts: see upgrade requests and switch plans. */
export function AdminPanel() {
  const listFn = useServerFn(adminListAccounts);
  const setPlanFn = useServerFn(adminSetPlan);
  const [rows, setRows] = useState<AccountRow[]>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    listFn()
      .then(setRows)
      .catch(() => setFailed(true));
  }, [listFn]);

  const change = (row: AccountRow) => {
    const plan = row.plan === "premium" ? "free" : "premium";
    setPlanFn({ data: { userId: row.userId, plan } })
      .then(setRows)
      .catch(() => setFailed(true));
  };

  return (
    <section className="mt-10">
      <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
        Accounts (only you can see this)
      </h2>
      {failed && (
        <p role="alert" className="mt-3 text-sm font-semibold text-destructive">
          The accounts could not be loaded or changed.
        </p>
      )}
      {rows?.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No accounts yet.</p>}
      {rows && rows.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-semibold">Email</th>
                <th className="px-4 py-2 font-semibold">Plan</th>
                <th className="px-4 py-2 font-semibold">Searches</th>
                <th className="px-4 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.userId} className="border-t border-border">
                  <td className="px-4 py-2">
                    {row.email}
                    {row.upgradeRequestedAt && (
                      <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                        asked to upgrade
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 capitalize">
                    {row.plan}
                    {row.premiumUntil && (
                      <span className="block text-xs normal-case text-muted-foreground">
                        paid, until {shortDate(row.premiumUntil)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{row.searchesUsed}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => change(row)}
                      className="font-semibold text-primary underline-offset-2 hover:underline"
                    >
                      {row.plan === "premium" ? "Make free" : "Make premium"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
