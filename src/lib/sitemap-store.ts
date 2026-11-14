import type { CatalogItem, Offer } from "./price-results";
import type { StoreConfig } from "./stores.config";
import { CACHE_TTL_MS, findJsonLdProduct, USER_AGENT, type JsonLd } from "./web";

/**
 * Stores that are not on Shopify but publish a sitemap (Mazaya, Faces).
 *
 * The sitemap lists every product page, and the page address contains the
 * product's name ("/en/p/maybelline-fit-me-foundation-123.html"). So:
 *   1. the sitemap is downloaded (and reused for 6 hours) to learn the names,
 *   2. the search picks the product pages whose names fit,
 *   3. only those few pages are opened to read the real name and price.
 */

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SITEMAP_FILES = 10;
/** Product pages opened per store for one search, to stay polite and fast. */
const MAX_PAGES_PER_SEARCH = 10;
const PAGE_CONCURRENCY = 5;

type SitemapStore = Extract<StoreConfig, { type: "sitemap" }>;

/**
 * Every product page of the store, named after the words in its address.
 * The prices are not known yet: they are read later by priceSitemapOffers.
 */
export async function downloadSitemapCatalog(store: SitemapStore): Promise<CatalogItem[]> {
  const isProduct = new RegExp(store.productPattern);
  const first = await fetchText(store.sitemap);
  // A sitemap index points at further sitemap files.
  const files = /<sitemap[\s>]/.test(first)
    ? await Promise.all(locations(first).slice(0, MAX_SITEMAP_FILES).map(fetchText))
    : [first];

  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  for (const xml of files) {
    for (const url of locations(xml)) {
      if (seen.has(url) || !isProduct.test(url)) continue;
      seen.add(url);
      const name = nameFromAddress(url);
      if (!name) continue;
      items.push({
        store: store.name,
        name,
        price: Number.NaN, // not known until the page is opened
        currency: store.currency ?? "EGP",
        url,
        matchText: name,
      });
    }
  }
  if (items.length === 0) throw new Error("no product pages found in the sitemap");
  return items;
}

function locations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

/** "/en/p/bourjois-healthy-mix-foundation-004817844071.html" -> "bourjois healthy mix foundation" */
function nameFromAddress(url: string): string {
  let slug = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* keep the raw text */
  }
  return slug
    .replace(/\.html?$/i, "")
    .replace(/-html\d*$/i, "")
    .replace(/(\p{L}{3})\d+$/u, "$1") // "foundation1332" -> "foundation"
    .split(/[-_+\s]+/)
    .filter((word) => word && !/^\d{5,}$/.test(word))
    .join(" ");
}

const pageCache = new Map<string, { loadedAt: number; offer: Offer | null }>();

/**
 * Open the product pages of the given matches and return them with their real
 * name and price. Products that are sold out or show no price are left out.
 */
export async function priceSitemapOffers(matches: Offer[]): Promise<Offer[]> {
  // The shortest names are the closest to what was typed.
  const perStore = new Map<string, Offer[]>();
  for (const match of [...matches].sort((a, b) => a.name.length - b.name.length)) {
    const list = perStore.get(match.store) ?? [];
    if (list.length < MAX_PAGES_PER_SEARCH) list.push(match);
    perStore.set(match.store, list);
  }
  const chosen = [...perStore.values()].flat();

  const priced: Offer[] = [];
  for (let i = 0; i < chosen.length; i += PAGE_CONCURRENCY) {
    const batch = await Promise.all(chosen.slice(i, i + PAGE_CONCURRENCY).map(readProductPage));
    for (const offer of batch) if (offer) priced.push(offer);
  }
  return priced;
}

async function readProductPage(match: Offer): Promise<Offer | null> {
  const cached = pageCache.get(match.url);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.offer;
  let offer: Offer | null = null;
  try {
    offer = offerFromPage(await fetchText(match.url), match);
  } catch (err) {
    // A page the sitemap still lists but the store has removed: remember that.
    if (err instanceof Error && err.message === "HTTP 404") {
      pageCache.set(match.url, { loadedAt: Date.now(), offer: null });
      return null;
    }
    console.warn(`[sitemap-store] could not read ${match.url}:`, err);
    return null; // not remembered: try again on the next search
  }
  pageCache.set(match.url, { loadedAt: Date.now(), offer });
  return offer;
}

/** The name and price a product page states in its schema.org Product information. */
function offerFromPage(html: string, match: Offer): Offer | null {
  const product = findJsonLdProduct(html);
  if (!product) return null;
  const offers = ([] as unknown[]).concat(product["offers"] ?? []) as JsonLd[];
  const inStock = offers.filter(
    (o) => !/OutOfStock|SoldOut|Discontinued/i.test(String(o["availability"] ?? "")),
  );
  const prices = inStock
    .map((o) => Number.parseFloat(String(o["price"] ?? o["lowPrice"] ?? "")))
    .filter((p) => Number.isFinite(p) && p > 0);
  if (prices.length === 0) return null;

  const clean = (text: unknown) =>
    (typeof text === "string" ? text : "").replace(/&amp;/g, "&").replace(/^["'\s]+|["'\s]+$/g, "");
  const title = clean(product["name"]) || match.name;
  // Put the brand in front when the page's product name leaves it out.
  const brandInfo = product["brand"];
  const brand = clean(
    brandInfo && typeof brandInfo === "object" ? (brandInfo as JsonLd)["name"] : brandInfo,
  );
  const name =
    brand && !title.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${title}` : title;
  const image = ([] as unknown[]).concat(product["image"] ?? [])[0];
  const currency = inStock.map((o) => o["priceCurrency"]).find((c) => typeof c === "string");
  return {
    store: match.store,
    name: name.slice(0, 300),
    price: Math.min(...prices),
    currency: currency ?? match.currency,
    url: match.url,
    ...(typeof image === "string" && image.startsWith("http") ? { image } : {}),
  };
}

/**
 * Download a page, keeping the cookies the site sets while it redirects
 * (Faces answers the first request with a cookie and a redirect to itself).
 */
async function fetchText(address: string): Promise<string> {
  const host = new URL(address).hostname;
  const cookies = new Map<string, string>();
  let current = address;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xml,text/xml",
        ...(cookies.size > 0
          ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") }
          : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const equals = pair.indexOf("=");
      if (equals > 0) cookies.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const next = new URL(res.headers.get("location") ?? "", current);
      if (next.hostname !== host) throw new Error(`redirected away to ${next.hostname}`);
      current = next.href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  throw new Error("too many redirects");
}
