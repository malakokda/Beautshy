import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  adminListAccounts,
  adminSetPlan,
  requestUpgrade,
  signIn,
  signOut,
  signUp,
} from "@/lib/account.functions";
import { FREE_SEARCHES, PREMIUM_PRICE_EGP, type Account, type AccountRow } from "@/lib/plans";

const inputClass =
  "w-full rounded-lg border border-input bg-background px-4 py-3 text-base outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/30";
const primaryButton =
  "rounded-lg bg-primary px-6 py-3 text-base font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";

/** Shown instead of the search box until the visitor signs in or creates an account. */
export function AuthCard({ onSignedIn }: { onSignedIn: (account: Account) => void }) {
  const signInFn = useServerFn(signIn);
  const signUpFn = useServerFn(signUp);
  const [mode, setMode] = useState<"signIn" | "signUp">("signUp");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const res = await (mode === "signIn" ? signInFn : signUpFn)({ data: { email, password } });
      if (!res.ok) setError(res.error);
      else if (res.account) onSignedIn(res.account);
      else {
        setMessage(res.message);
        setMode("signIn");
        setPassword("");
      }
    } catch {
      setError("Please enter a valid email and a password of at least 8 characters.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className="font-display text-2xl font-semibold">
        {mode === "signUp" ? "Create a free account to search" : "Sign in to search"}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A free account includes {FREE_SEARCHES} searches. Premium is unlimited for EGP{" "}
        {PREMIUM_PRICE_EGP} a month.
      </p>

      <form onSubmit={onSubmit} className="mt-5 space-y-3">
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email address"
          aria-label="Email address"
          className={inputClass}
        />
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
          onClick={() => {
            setMode(mode === "signUp" ? "signIn" : "signUp");
            setError(undefined);
          }}
          className="font-semibold text-primary underline-offset-2 hover:underline"
        >
          {mode === "signUp" ? "Sign in" : "Create a free account"}
        </button>
      </p>
    </div>
  );
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
      ? "Premium · unlimited searches"
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

/** Shown when the free searches are used up. */
export function UpgradeCard({
  account,
  onChanged,
}: {
  account: Account;
  onChanged: (account: Account) => void;
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
      {account.upgradeRequested ? (
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
    </div>
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
                  <td className="px-4 py-2 capitalize">{row.plan}</td>
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
