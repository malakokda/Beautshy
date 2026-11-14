import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listStores, searchPrices } from "@/lib/search.functions";
import type { Offer } from "@/lib/price-results";

/** Example searches shown under the search box. */
const EXAMPLES = ["Garnier Micellar Water 400ml", "Cerave Foaming Cleanser", "Vitamin C Serum"];

type SearchState = {
  phase: "idle" | "loading" | "done" | "failed";
  query: string;
  /** The product name actually searched (the name read from a pasted link). */
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
      { title: "GlowSouq — Top 10 Cheapest Cosmetics Prices in Egypt" },
      {
        name: "description",
        content:
          "Search any cosmetics product and compare the 10 cheapest offers from Egyptian online stores, including Amazon Egypt.",
      },
      { property: "og:title", content: "GlowSouq — Top 10 Cheapest Cosmetics Prices in Egypt" },
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

function formatPrice(price: number, currency = "EGP") {
  return `${currency} ${price.toLocaleString("en-EG", { maximumFractionDigits: 2 })}`;
}

function Index() {
  const searchPricesFn = useServerFn(searchPrices);

  const [mode, setMode] = useState<"name" | "url">("name");
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

  const runSearch = useCallback(
    async (rawQuery: string, searchMode: "name" | "url") => {
      const query = rawQuery.trim();
      if (query.length < 2) return;
      setSearch({ phase: "loading", query, results: [] });
      try {
        const res = await searchPricesFn({ data: { query, mode: searchMode } });
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
            : { phase: "failed", query, term: res.term, results: [], error: res.error },
        );
      } catch {
        setSearch({
          phase: "failed",
          query,
          results: [],
          error: "Something went wrong. Please try again.",
        });
      }
    },
    [searchPricesFn],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runSearch(input, mode);
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
          <div className="mb-4 flex gap-1 rounded-lg bg-muted p-1 text-sm font-semibold">
            {(
              [
                ["name", "Search by name"],
                ["url", "Paste product or store link"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                className={`flex-1 rounded-md px-3 py-2 transition-colors ${
                  mode === value
                    ? "bg-card text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                mode === "name"
                  ? "e.g. Garnier Micellar Water 400ml"
                  : "https://… product page or store link"
              }
              aria-label="Product to search for"
              className="min-w-0 flex-1 rounded-lg border border-input bg-background px-4 py-3 text-base outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
            <button
              type="submit"
              disabled={search.phase === "loading" || input.trim().length < 2}
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
                onClick={() => {
                  setInput(example);
                  void runSearch(example, "name");
                }}
                className="rounded-full border border-border bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground transition-colors hover:border-primary hover:text-primary"
              >
                {example}
              </button>
            ))}
          </div>
        </section>

        {/* Results */}
        <section className="mt-10" aria-live="polite">
          {search.phase === "idle" && <IdleState />}
          {search.phase === "loading" && <PendingState query={search.query} />}
          {search.phase === "failed" && (
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
        </section>

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
