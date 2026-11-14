import type { CatalogItem, Offer } from "./price-results";
import type { StoreConfig } from "./stores.config";
import { downloadSitemapCatalog, priceSitemapOffers } from "./sitemap-store";
import { findBestMatches, tokens, wordSet, type Entry, type Vocabulary } from "./fuzzy-match";
import { takeDailyAllowance } from "./rate-limit";
import { CACHE_TTL_MS, getJson, siteName } from "./web";

/** Catalog pages downloaded at the same time per store. */
const PAGE_CONCURRENCY = 4;
const MAX_PAGES = 80; // 80 x 250 = 20,000 products per store

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
 * Scan every product of every configured store and return the ones that best
 * fit the search term, cheapest first. Misspelled and partial names are
 * understood (see fuzzy-match.ts).
 */
export async function searchStores(
  term: string,
  stores: StoreConfig[],
): Promise<StoreSearchResult> {
  const failures: StoreSearchResult["failures"] = [];
  const fail = (store: StoreConfig, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push({ store: store.name, reason });
    console.error(`[store-search] ${store.name} failed:`, reason);
  };

  // 1. Full product lists of the Shopify and sitemap stores (cached).
  const listed = stores.filter((s) => s.type !== "amazon");
  const catalogResults = await Promise.allSettled(listed.map(getCatalog));
  const catalogs: Catalog[] = [];
  // Stores answered by a live search: Amazon, and Shopify stores without a catalog feed.
  const live = stores.filter((s) => s.type === "amazon");
  catalogResults.forEach((result, i) => {
    if (result.status === "fulfilled") catalogs.push(result.value);
    else if (listed[i]!.type === "sitemap") fail(listed[i]!, result.reason);
    else {
      console.warn(
        `[store-search] ${listed[i]!.name}: full catalog unavailable, using store search`,
        result.reason,
      );
      live.push(listed[i]!);
    }
  });

  // 2. Live searches, using the spelling the catalogs know ("garnir" -> "garnier").
  const liveTerm = bestMatches(term, catalogs).corrected ?? term;
  const liveResults = await Promise.allSettled(
    live.map((store) =>
      store.type === "amazon"
        ? searchAmazon(store, liveTerm)
        : searchShopifySuggest(store, liveTerm),
    ),
  );
  const liveItems: CatalogItem[] = [];
  liveResults.forEach((result, i) => {
    if (result.status === "fulfilled") liveItems.push(...result.value);
    else fail(live[i]!, result.reason);
  });
  catalogs.push(buildCatalog(liveItems));

  // 3. Keep the products that fit the search best.
  const best = bestMatches(term, catalogs);
  const { approximate, corrected } = best;
  // Sitemap stores know only product names so far: open the matching pages for prices.
  const unpriced = new Set(stores.filter((s) => s.type === "sitemap").map((s) => s.name));
  const matches = [
    ...best.matches.filter((o) => !unpriced.has(o.store)),
    ...(await priceSitemapOffers(best.matches.filter((o) => unpriced.has(o.store)))),
  ];

  // Drop repeats: same link, or same store + name + price.
  const seen = new Set<string>();
  const unique = matches.filter((o) => {
    const keys = [o.url, `${o.store}|${o.name.toLowerCase()}|${o.price}`];
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
  unique.sort((a, b) => a.price - b.price);
  return { offers: unique, failures, corrected, approximate };
}

/** A store's products prepared for matching, with the words their names use. */
type Catalog = { entries: Entry<Offer>[]; vocabulary: Vocabulary };

function bestMatches(term: string, catalogs: Catalog[]) {
  return findBestMatches(
    term,
    catalogs.flatMap((c) => c.entries),
    catalogs.map((c) => c.vocabulary),
  );
}

function buildCatalog(items: CatalogItem[]): Catalog {
  const vocabulary: Vocabulary = new Map();
  const entries = items.map(({ matchText, ...offer }) => ({
    item: offer,
    words: wordSet(matchText, vocabulary),
  }));
  return { entries, vocabulary };
}

/* ---------- Amazon Egypt through SerpAPI's Amazon search (needs SERPAPI_KEY) ---------- */

/**
 * New Amazon searches allowed per day (8 a day is about 240 a month). Change it
 * with the AMAZON_SEARCHES_PER_DAY setting to match your SerpAPI plan.
 */
const AMAZON_SEARCHES_PER_DAY = Number(process.env["AMAZON_SEARCHES_PER_DAY"]) || 8;

/** Each Amazon search uses one SerpAPI credit, so answers are reused for 6 hours. */
const amazonCache = new Map<string, { loadedAt: number; items: CatalogItem[] }>();

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
  const cacheKey = `${domain}|${tokens(term).join(" ")}`;
  const cached = amazonCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.items;
  // Every new search costs a SerpAPI credit, so only so many are made per day.
  if (!takeDailyAllowance("amazon", AMAZON_SEARCHES_PER_DAY)) {
    throw new Error(`today's limit of ${AMAZON_SEARCHES_PER_DAY} Amazon searches is used up`);
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "amazon");
  url.searchParams.set("amazon_domain", domain);
  url.searchParams.set("k", term);
  url.searchParams.set("language", "en_AE");
  url.searchParams.set("api_key", apiKey);
  const data = await getJson<{ error?: string; organic_results?: SerpAmazonResult[] }>(url.href);
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
  amazonCache.set(cacheKey, { loadedAt: Date.now(), items });
  return items;
}

function absoluteUrl(path: string, base: string): string | undefined {
  try {
    return new URL(path, base).href;
  } catch {
    return undefined;
  }
}

/* ---------- Shopify full catalog: /products.json (every product, cached) ---------- */

type ShopifyCatalogProduct = {
  title?: string;
  handle?: string;
  vendor?: string;
  variants?: { id?: number; title?: string; price?: string; available?: boolean }[];
  images?: { src?: string }[];
};

const catalogCache = new Map<string, { loadedAt: number; catalog: Catalog }>();
const catalogLoading = new Map<string, Promise<Catalog>>();

async function getCatalog(store: StoreConfig): Promise<Catalog> {
  const cached = catalogCache.get(store.url);
  const fresh = cached && Date.now() - cached.loadedAt < CACHE_TTL_MS;
  if (cached && fresh) return cached.catalog;

  let loading = catalogLoading.get(store.url);
  if (!loading) {
    loading = (
      store.type === "sitemap" ? downloadSitemapCatalog(store) : downloadShopifyCatalog(store)
    )
      .then((items) => {
        const catalog = buildCatalog(items);
        catalogCache.set(store.url, { loadedAt: Date.now(), catalog });
        return catalog;
      })
      .finally(() => catalogLoading.delete(store.url));
    catalogLoading.set(store.url, loading);
  }
  // A stale copy answers straight away while the new one downloads.
  if (cached) {
    loading.catch((err) => console.error(`[store-search] ${store.name} refresh failed:`, err));
    return cached.catalog;
  }
  return loading;
}

async function downloadShopifyCatalog(store: StoreConfig): Promise<CatalogItem[]> {
  const items: CatalogItem[] = [];
  for (let first = 1; first <= MAX_PAGES; first += PAGE_CONCURRENCY) {
    const pages = Array.from({ length: PAGE_CONCURRENCY }, (_, i) => first + i);
    const batches = await Promise.all(
      pages.map((page) => {
        const url = new URL("/products.json", store.url);
        url.searchParams.set("limit", "250");
        url.searchParams.set("page", String(page));
        return getJson<{ products?: ShopifyCatalogProduct[] }>(url.href).then(
          (d) => d.products ?? [],
        );
      }),
    );
    for (const products of batches) {
      for (const p of products) items.push(...shopifyProductToItems(store, p));
    }
    if (batches.some((products) => products.length < 250)) break;
  }
  return items;
}

/** One catalog item per variant, so sizes such as 100ml and 400ml are priced separately. */
function shopifyProductToItems(store: StoreConfig, p: ShopifyCatalogProduct): CatalogItem[] {
  const title = p.title?.trim();
  if (!title || !p.handle) return [];
  const productUrl = absoluteUrl(`/products/${p.handle}`, store.url);
  if (!productUrl) return [];
  const image = p.images?.[0]?.src;
  const items: CatalogItem[] = [];
  for (const v of p.variants ?? []) {
    const price = Number.parseFloat(v.price ?? "");
    if (v.available === false || !Number.isFinite(price) || price <= 0) continue;
    const variant = v.title && v.title !== "Default Title" ? v.title.trim() : "";
    const name =
      variant && !title.toLowerCase().includes(variant.toLowerCase())
        ? `${title} - ${variant}`
        : title;
    items.push({
      store: store.name,
      name: name.slice(0, 300),
      price,
      currency: store.currency ?? "EGP",
      url: variant && v.id ? `${productUrl}?variant=${v.id}` : productUrl,
      ...(image ? { image } : {}),
      matchText: `${p.vendor ?? ""} ${name}`,
    });
  }
  return items;
}

/* ---------- Shopify search box: /search/suggest.json (fallback, top 10 only) ---------- */

type ShopifySuggestProduct = {
  title?: string;
  price?: string;
  url?: string;
  image?: string;
  available?: boolean;
  vendor?: string;
};

async function searchShopifySuggest(store: StoreConfig, term: string): Promise<CatalogItem[]> {
  const url = new URL("/search/suggest.json", store.url);
  url.searchParams.set("q", term);
  url.searchParams.set("resources[type]", "product");
  url.searchParams.set("resources[limit]", "10");
  const data = await getJson<{ resources?: { results?: { products?: ShopifySuggestProduct[] } } }>(
    url.href,
  );
  const items: CatalogItem[] = [];
  for (const p of data.resources?.results?.products ?? []) {
    const price = Number.parseFloat(p.price ?? "");
    const link = p.url ? absoluteUrl(p.url.split("?")[0]!, store.url) : undefined;
    const name = p.title?.trim();
    if (p.available === false || !Number.isFinite(price) || price <= 0 || !link || !name) continue;
    const image = p.image ? absoluteUrl(p.image, store.url) : undefined;
    items.push({
      store: store.name,
      name: name.slice(0, 300),
      price,
      currency: store.currency ?? "EGP",
      url: link,
      ...(image ? { image } : {}),
      matchText: `${p.vendor ?? ""} ${name}`,
    });
  }
  return items;
}
