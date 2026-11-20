import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AccountBar, AdminPanel, AuthCard, UpgradeCard, UpgradeDialog } from "@/components/account";
import { getMyAccount } from "@/lib/account.functions";
import type { Account } from "@/lib/plans";
import { listStores, searchPrices } from "@/lib/search.functions";
import type { Offer } from "@/lib/price-results";

/** Example searches shown under the search box. */
const EXAMPLES = ["Garnier Micellar Water 400ml", "Cerave Foaming Cleanser", "Vitamin C Serum"];

type SearchState = {
  phase: "idle" | "loading" | "done" | "failed";
  query: string;
  /** The product name actually searched (spelling fixed, or read from a pasted link). */
  term?: string;
  /** What was typed, when the spelling was fixed. */
  typed?: string;
  /** True when the results are only the closest products, not the whole name. */
  approximate?: boolean;
  /** A message about the pasted link's website, e.g. that it was added to the stores. */
  notice?: string;
  results: Offer[];
  error?: string;
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Beautshy — Top 10 Cheapest Cosmetics Prices in Egypt" },
      {
        name: "description",
        content:
          "Search any cosmetics product and compare the 10 cheapest offers from Egyptian online stores, including Amazon Egypt.",
      },
      { property: "og:title", content: "Beautshy — Top 10 Cheapest Cosmetics Prices in Egypt" },
      {
        property: "og:description",
        content:
          "Search any cosmetics product and instantly compare the 10 cheapest offers from Egypt's online stores.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function formatPrice(price: number, currency: string) {
  return `${currency} ${price.toLocaleString("en-EG", { maximumFractionDigits: 2 })}`;
}

function Index() {
  const searchPricesFn = useServerFn(searchPrices);

  const [input, setInput] = useState("");
  const [search, setSearch] = useState<SearchState>({ phase: "idle", query: "", results: [] });

  // The stores being searched, shown under the results. Reloaded after every
  // search because pasting a link can add a store.
  const listStoresFn = useServerFn(listStores);
  const [stores, setStores] = useState<{ name: string; url: string }[]>([]);
  useEffect(() => {
    if (search.phase === "loading") return;
    listStoresFn()
      .then(setStores)
      .catch(() => {});
  }, [listStoresFn, search.phase]);

  // Who is signed in: undefined while loading, null when nobody is.
  const getMyAccountFn = useServerFn(getMyAccount);
  const [account, setAccount] = useState<Account | null>();
  const [accountsDown, setAccountsDown] = useState(false);
  const refreshAccount = useCallback(
    () =>
      getMyAccountFn()
        .then((loaded) => {
          setAccount(loaded);
          setAccountsDown(false);
        })
        .catch(() => {
          setAccount(null);
          setAccountsDown(true);
        }),
    [getMyAccountFn],
  );
  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);
  /** True when a free account has no searches left. */
  const outOfSearches = account?.searchesLeft === 0;
  /** The upgrade pop-up opens when the searches run out, until "Not now" is clicked. */
  const [upgradeDismissed, setUpgradeDismissed] = useState(false);

  // Back from Paymob's payment page. The address Paymob sends people back to
  // proves nothing by itself; premium is switched on only by Paymob's signed
  // message to the server. So the page just checks the account until it is premium.
  const [payment, setPayment] = useState<"checking" | "done" | "waiting">();
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("payment") !== "return") return;
    url.search = "";
    window.history.replaceState(null, "", url.pathname + url.hash);
    setPayment("checking");
    let tries = 0;
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      const loaded = await getMyAccountFn().catch(() => null);
      if (stopped) return;
      if (loaded) setAccount(loaded);
      if (loaded?.plan === "premium") return setPayment("done");
      if (++tries >= 15) return setPayment("waiting");
      setTimeout(() => void check(), 2_000);
    };
    void check();
    return () => {
      stopped = true;
    };
  }, [getMyAccountFn]);

  const runSearch = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      if (query.length < 2) return;
      setSearch({ phase: "loading", query, results: [] });
      try {
        const res = await searchPricesFn({ data: { query } });
        setSearch(
          res.ok
            ? {
                phase: "done",
                query,
                term: res.term,
                approximate: res.approximate,
                results: res.results,
                ...(res.typed ? { typed: res.typed } : {}),
                ...(res.notice ? { notice: res.notice } : {}),
              }
            : { phase: "failed", query, results: [], error: res.error },
        );
      } catch {
        setSearch({
          phase: "failed",
          query,
          results: [],
          error: "Something went wrong. Please try again.",
        });
      }
      // The search may have used up a free search, or the sign-in may have expired.
      void refreshAccount();
    },
    [searchPricesFn, refreshAccount],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runSearch(input);
  };

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      {/* Hero */}
      <header className="border-b border-border bg-secondary/60">
        <div className="mx-auto max-w-3xl px-6 pt-14 pb-10 text-center">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-primary/70">
            Cosmetics price finder · Egypt
          </p>
          <h1 className="mt-4 font-display text-4xl font-semibold leading-tight sm:text-5xl">
            The 10 cheapest offers,{" "}
            <span className="italic text-primary">across Egypt&apos;s stores.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
            Type a product or paste a link — spelling mistakes and half names are fine. The search
            scans Egyptian online shops and lines up the lowest prices, cheapest first.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-24">
        {/* Search card */}
        <section className="-mt-6 rounded-2xl border border-border bg-card p-5 shadow-lg shadow-primary/5 sm:p-6">
          {account === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
          {account === null && (
            <>
              {accountsDown && (
                <p role="alert" className="mb-4 text-sm font-semibold text-destructive">
                  Accounts are not available right now. Please try again later.
                </p>
              )}
              <AuthCard onSignedIn={setAccount} />
            </>
          )}
          {payment && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-semibold"
            >
              {payment === "checking" && "Checking your payment…"}
              {payment === "done" &&
                "Payment received. You're on Premium: search as much as you like!"}
              {payment === "waiting" &&
                "We haven't received the payment confirmation yet. If you paid, refresh the page in a minute. If the payment didn't go through, you can try again."}
            </p>
          )}
          {account && (
            <>
              <AccountBar
                account={account}
                onSignedOut={() => {
                  setAccount(null);
                  setUpgradeDismissed(false);
                  setSearch({ phase: "idle", query: "", results: [] });
                }}
              />
              <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Product name, or a link to a product or store"
                  aria-label="Product to search for"
                  className="min-w-0 flex-1 rounded-lg border border-input bg-background px-4 py-3 text-base outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/30"
                />
                <button
                  type="submit"
                  disabled={search.phase === "loading" || input.trim().length < 2 || outOfSearches}
                  className="rounded-lg bg-primary px-6 py-3 text-base font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  Find prices
                </button>
              </form>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Try:
                </span>
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    disabled={outOfSearches}
                    onClick={() => {
                      setInput(example);
                      void runSearch(example);
                    }}
                    className="rounded-full border border-border bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground transition-colors hover:border-primary hover:text-primary"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        {/* Results */}
        {account && (
          <section className="mt-10" aria-live="polite">
            {search.phase === "idle" && !outOfSearches && <IdleState />}
            {search.phase === "loading" && <PendingState query={search.query} />}
            {search.phase === "failed" && !outOfSearches && (
              <ErrorState message={search.error ?? "The search failed."} />
            )}
            {search.phase === "done" && (
              <ResultsList
                results={search.results}
                term={search.term}
                typed={search.typed}
                approximate={search.approximate}
                notice={search.notice}
              />
            )}
            {outOfSearches && search.phase !== "loading" && (
              <div className={search.phase === "done" ? "mt-8" : ""}>
                <UpgradeCard account={account} onChanged={setAccount} />
              </div>
            )}
          </section>
        )}

        {stores.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Stores we search ({stores.length})
            </h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {stores.map((store) => (
                <li key={store.url}>
                  <a
                    href={store.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-foreground transition-colors hover:border-primary hover:text-primary"
                  >
                    {store.name}
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Paste a link from another Egyptian store to add it to this list.
            </p>
          </section>
        )}

        {account?.isAdmin && <AdminPanel />}
        {account && (
          <UpgradeDialog
            account={account}
            open={outOfSearches && !upgradeDismissed && search.phase !== "loading"}
            onClose={() => setUpgradeDismissed(true)}
            onChanged={setAccount}
          />
        )}
      </main>

      <footer className="border-t border-border bg-secondary/40 py-8 text-center text-xs text-muted-foreground">
        Prices are read live from each store's website when you search. Always confirm the price on
        the store page before buying.
      </footer>
    </div>
  );
}

function IdleState() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/60 p-10 text-center text-muted-foreground">
      <p className="font-display text-lg text-foreground">
        Search for a product to see its cheapest offers.
      </p>
      <p className="mt-2 text-sm">
        Every result shows the store, the price in EGP, and a direct link to buy.
      </p>
    </div>
  );
}

function PendingState({ query }: { query: string }) {
  return (
    <div>
      <p className="mb-5 text-center text-sm font-semibold text-primary">
        Scanning every product in our Egyptian stores for “{query}”…
      </p>
      <div className="space-y-3" aria-hidden>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 rounded-xl border border-border bg-card p-4"
          >
            <div className="h-14 w-14 animate-pulse rounded-lg bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-6 w-20 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
      <p className="font-display text-lg text-destructive">{message}</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Try fewer words — the brand and the product type are enough.
      </p>
    </div>
  );
}

function ResultsList({
  results,
  term,
  typed,
  approximate,
  notice,
}: {
  results: Offer[];
  term?: string | undefined;
  typed?: string | undefined;
  approximate?: boolean | undefined;
  notice?: string | undefined;
}) {
  const noticeBox = notice && (
    <p className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-semibold text-foreground">
      {notice}
    </p>
  );
  if (results.length === 0 && noticeBox) return noticeBox;
  if (results.length === 0) {
    return <ErrorState message="No offers with a clear price were found for this product." />;
  }
  return (
    <div>
      {noticeBox}
      <h2 className="mb-4 font-display text-2xl font-semibold">
        Cheapest offers, lowest price first
      </h2>
      {term && (
        <p className="-mt-2 mb-4 text-sm text-muted-foreground">
          {typed ? "Showing results for" : "Products matching"} “
          <span className="font-semibold text-foreground">{term}</span>”
          {typed && <> — you typed “{typed}”</>}
        </p>
      )}
      {approximate && (
        <p className="mb-4 rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-secondary-foreground">
          No product has that whole name, so these are the closest ones we found.
        </p>
      )}
      <ol className="space-y-3">
        {results.map((offer, i) => (
          <li key={`${offer.store}-${offer.url}-${i}`}>
            <a
              href={offer.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-secondary/50"
            >
              <span className="w-7 shrink-0 text-center font-display text-xl font-bold text-primary/50">
                {i + 1}
              </span>
              {offer.image ? (
                <img
                  src={offer.image}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-lg border border-border object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="h-14 w-14 shrink-0 rounded-lg border border-border bg-muted" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{offer.name}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">{offer.store}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-display text-lg font-bold text-primary">
                  {formatPrice(offer.price, offer.currency)}
                </span>
                <span className="text-xs font-semibold text-muted-foreground group-hover:text-primary">
                  Buy →
                </span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
