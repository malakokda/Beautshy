/**
 * One search, start to finish. Server-only (loaded by search.functions.ts):
 * 1. adds a pasted link's website to the searched stores, if it is new,
 * 2. turns the link into a product name,
 * 3. searches every store (stores.config.ts plus the added ones),
 * 4. keeps the cheapest offers.
 */
import { topCheapest } from "./price-results";
import { productFromLink } from "./product-link";
import type { SearchResponse } from "./search.functions";
import { getStores, registerStoreFromLink } from "./store-registry";
import { searchStores } from "./store-search";

const SITE_ADDRESS =
  /^(https?:\/\/\S+|(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|eg|me|co|shop|store|tv|io)(\/\S*)?)$/i;

/** The link typed into the search box, if it is one and not a product name. */
function linkIn(query: string): URL | null {
  if (!SITE_ADDRESS.test(query)) return null;
  try {
    return new URL(/^https?:\/\//i.test(query) ? query : `https://${query}`);
  } catch {
    return null;
  }
}

/** True for a link to a store's front page or product list, not to one product. */
function isStoreHome(url: URL): boolean {
  return /^(\/[a-z]{2}(-[a-z]{2})?)?(\/collections(\/all)?)?$/i.test(
    url.pathname.replace(/\/+$/, ""),
  );
}

export async function runSearch(query: string): Promise<SearchResponse> {
  // A pasted link: make its website one of the searched stores.
  const link = linkIn(query);
  let notice: string | undefined;
  if (link) {
    const registration = await registerStoreFromLink(link).catch((err) => {
      console.error("[search] could not check the link's website:", err);
      return null;
    });
    const home = isStoreHome(link);
    if (registration?.status === "added") {
      notice = `${registration.store.name} was added to the stores we search.`;
    } else if (registration?.status === "unsupported") {
      notice = `${registration.site} could not be added to the stores we search: ${registration.reason}.`;
      if (home) return { ok: false, term: registration.site, error: notice };
    } else if (registration && home) {
      notice = `${registration.store.name} is already one of the stores we search.`;
    }
    // A link to the store itself, not to a product: there is nothing to price yet.
    if (home && registration && registration.status !== "unsupported") {
      return {
        ok: true,
        term: registration.store.name,
        approximate: false,
        results: [],
        notice: `${notice} Now search for a product to compare its prices.`,
      };
    }
  }
  const stores = await getStores();

  // The link also gives the product's name (and, for Shopify stores, its own price).
  const linked = link ? await productFromLink(link) : null;
  const names = linked?.names ?? [query];
  if (linked?.outOfStock) {
    notice = `${notice ? `${notice} ` : ""}The linked product is out of stock at its own store.`;
  }

  let typed = names[0]!;
  let found = await searchStores(typed, stores);
  // Nothing under the page's name (it may be Arabic): try the words in the link.
  for (const name of names.slice(1)) {
    if (found.offers.length > 0 && !found.approximate) break;
    const next = await searchStores(name, stores);
    if (next.offers.length > 0 && (found.offers.length === 0 || !next.approximate)) {
      typed = name;
      found = next;
    }
  }
  const { failures, corrected, approximate } = found;
  const term = corrected ?? typed;

  // Always include the linked product itself, unless a store already returned it.
  const offers = [...found.offers];
  const own = linked?.offer;
  if (own && !offers.some((o) => o.url.split("?")[0] === own.url)) offers.push(own);
  const results = topCheapest(offers);

  if (results.length === 0) {
    const error =
      failures.length === stores.length
        ? "None of the stores could be reached. Please try again in a minute."
        : `Nothing close to “${typed}” was found in ${stores.length - failures.length} Egyptian stores. Try fewer words, such as the brand and the product type.`;
    return { ok: false, term, error: notice ? `${notice} ${error}` : error };
  }
  return {
    ok: true,
    term,
    approximate,
    results,
    ...(corrected ? { typed } : {}),
    ...(notice ? { notice } : {}),
  };
}
