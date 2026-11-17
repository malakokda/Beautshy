import { getStoreIndexes } from "./catalog";
import { query } from "./db";
import { buildIndex, findBestMatches, tokens } from "./fuzzy-match";
import type { CatalogItem, Offer } from "./price-results";
import { takeDailyAllowance } from "./rate-limit";
import { priceSitemapOffers } from "./sitemap-store";
import type { StoreConfig } from "./stores.config";
import { getJson, siteName } from "./web";

export type StoreSearchResult = {
  offers: Offer[];
  /** Stores that could not be searched, with the reason. */
  failures: { store: string; reason: string }[];
  /** The search after fixing spelling mistakes, or null when nothing was changed. */
  corrected: string | null;
  /** True when no product has every search word and the closest ones are shown. */
  approximate: boolean;
};

/**
 * Find the products that best fit the search term in every given store.
 * Misspelled and partial names are understood (see fuzzy-match.ts).
 */
export async function searchStores(
  term: string,
  stores: StoreConfig[],
): Promise<StoreSearchResult> {
  // 1. The stores' product lists, already in memory (see catalog.ts).
  const { indexes, failures } = await getStoreIndexes(stores.filter((s) => s.type !== "amazon"));

  // 2. Amazon is searched live, using the spelling the product lists know ("garnir" -> "garnier").
  const amazonTerm = findBestMatches(term, indexes).corrected ?? term;
  const amazonItems: CatalogItem[] = [];
  for (const store of stores.filter((s) => s.type === "amazon")) {
    try {
      amazonItems.push(...(await searchAmazon(store, amazonTerm)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ store: store.name, reason });
      console.error(`[store-search] ${store.name} failed:`, reason);
    }
  }
  const amazonIndex = buildIndex(
    amazonItems.map(({ matchText, ...offer }) => ({ item: offer as Offer, text: matchText })),
  );

  // 3. Keep the products that fit the search best.
  const best = findBestMatches(term, [...indexes, amazonIndex]);
  // Sitemap stores know only product names so far: open the matching pages for prices.
  const unpriced = new Set(stores.filter((s) => s.type === "sitemap").map((s) => s.name));
  const matches = [
    ...best.matches.filter((o) => !unpriced.has(o.store)),
    ...(await priceSitemapOffers(best.matches.filter((o) => unpriced.has(o.store)))),
  ];

  // Drop repeats: same link, or same store + name + price.
  const seen = new Set<string>();
  const offers = matches.filter((o) => {
    const keys = [o.url, `${o.store}|${o.name.toLowerCase()}|${o.price}`];
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
  return { offers, failures, corrected: best.corrected, approximate: best.approximate };
}

/* ---------- Amazon Egypt through SerpAPI's Amazon search (needs SERPAPI_KEY) ---------- */

/**
 * New Amazon searches allowed per day, across all servers (8 a day is about 240
 * a month). Change it with the AMAZON_SEARCHES_PER_DAY setting to match your SerpAPI plan.
 */
const AMAZON_SEARCHES_PER_DAY = Number(process.env["AMAZON_SEARCHES_PER_DAY"]) || 8;
/** Each Amazon search costs a SerpAPI credit, so an answer is reused for a day. */
const AMAZON_ANSWER_HOURS = 24;

type SerpAmazonResult = {
  asin?: string;
  title?: string;
  brand?: string;
  extracted_price?: number;
  price?: string;
  link_clean?: string;
  link?: string;
  thumbnail?: string;
};

async function searchAmazon(store: StoreConfig, term: string): Promise<CatalogItem[]> {
  const apiKey = process.env["SERPAPI_KEY"];
  if (!apiKey) throw new Error("SERPAPI_KEY is not set in .env.local");
  const domain = siteName(new URL(store.url).hostname);
  const key = `${domain}|${tokens(term).join(" ")}`;

  const saved = await query<{ items: CatalogItem[] }>(
    `select items from amazon_cache
      where key = $1 and fetched_at > now() - make_interval(hours => $2::int)`,
    [key, AMAZON_ANSWER_HOURS],
  );
  if (saved[0]) return saved[0].items;
  if (!(await takeDailyAllowance("amazon", AMAZON_SEARCHES_PER_DAY))) {
    throw new Error(`today's limit of ${AMAZON_SEARCHES_PER_DAY} Amazon searches is used up`);
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "amazon");
  url.searchParams.set("amazon_domain", domain);
  url.searchParams.set("k", term);
  url.searchParams.set("language", "en_AE");
  url.searchParams.set("api_key", apiKey);
  const data = await getJson<{ error?: string; organic_results?: SerpAmazonResult[] }>(url);
  // SerpAPI answers "no results" as an error message; treat it as an empty list.
  if (data.error && !/hasn't returned any results/i.test(data.error)) {
    throw new Error(`SerpAPI: ${data.error}`);
  }

  const items: CatalogItem[] = [];
  for (const r of data.organic_results ?? []) {
    const price = r.extracted_price;
    // One standard link per product, so sponsored and normal listings collapse into one.
    const link = r.asin
      ? `https://${new URL(store.url).host}/dp/${r.asin}`
      : (r.link_clean ?? r.link);
    const title = r.title?.trim();
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || !link || !title) {
      continue;
    }
    if (r.price && !/EGP|E£|ج\.م/.test(r.price)) continue; // only Egyptian-pound prices
    const name =
      r.brand && !title.toLowerCase().includes(r.brand.toLowerCase())
        ? `${r.brand} ${title}`
        : title;
    items.push({
      store: store.name,
      name: name.slice(0, 300),
      price,
      currency: "EGP",
      url: link,
      ...(r.thumbnail ? { image: r.thumbnail } : {}),
      matchText: name,
    });
  }
  await query(
    `insert into amazon_cache (key, items) values ($1, $2::jsonb)
     on conflict (key) do update set items = excluded.items, fetched_at = now()`,
    [key, JSON.stringify(items)],
  );
  return items;
}
