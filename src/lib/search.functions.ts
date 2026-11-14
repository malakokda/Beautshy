import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { topCheapest, type Offer } from "./price-results";

const searchInput = z.object({
  query: z.string().trim().min(2).max(500),
  mode: z.enum(["name", "url"]).default("name"),
});

export type SearchResponse =
  | {
      ok: true;
      /** The product name searched, after fixing any spelling mistakes. */
      term: string;
      /** Set when the spelling was fixed: what was originally typed. */
      typed?: string;
      /** True when nothing has the whole name and the closest products are shown. */
      approximate: boolean;
      results: Offer[];
      /** A message about the pasted link's website, e.g. that it was added to the stores. */
      notice?: string;
    }
  | { ok: false; term: string; error: string };

const SITE_ADDRESS =
  /^(https?:\/\/\S+|(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|eg|me|co|shop|store|tv|io)(\/\S*)?)$/i;

/** The link in the search box, if there is one (also when typed into "Search by name"). */
function linkIn(query: string, mode: "name" | "url"): URL | null {
  if (mode === "name" && !SITE_ADDRESS.test(query)) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(query) ? query : `https://${query}`);
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

/**
 * Runs on the server when the page asks for a search:
 * 1. adds a pasted link's website to the searched stores, if it is new,
 * 2. turns the link into a product name,
 * 3. searches every store (stores.config.ts plus the added ones),
 * 4. keeps the cheapest offers and saves the search in the database.
 */
export const searchPrices = createServerFn({ method: "POST" })
  .inputValidator((data) => searchInput.parse(data))
  .handler(async ({ data }): Promise<SearchResponse> => {
    // Server-only modules are loaded here so they never reach the browser.
    const [{ productFromLink }, { searchStores }, registry, { supabaseAdmin }] = await Promise.all([
      import("./product-link"),
      import("./store-search"),
      import("./store-registry"),
      import("@/integrations/supabase/client.server"),
    ]);

    // Stop one visitor from flooding the stores with searches.
    const [{ getRequestIP }, { allowSearch }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./rate-limit"),
    ]);
    if (!allowSearch(getRequestIP({ xForwardedFor: true }) ?? "unknown")) {
      return {
        ok: false,
        term: data.query,
        error: "Too many searches at once. Please wait a minute and try again.",
      };
    }

    // A pasted link: make its website one of the searched stores.
    const link = linkIn(data.query, data.mode);
    let notice: string | undefined;
    if (link) {
      const registration = await registry.registerStoreFromLink(link).catch((err) => {
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
    const STORES = await registry.getStores();

    // The link also gives the product's name (and, for Shopify stores, its own price).
    const linked = link ? await productFromLink(link.href) : null;
    const names = linked?.names ?? [data.query];
    if (linked?.outOfStock) {
      notice = `${notice ? `${notice} ` : ""}The linked product is out of stock at its own store.`;
    }

    let typed = names[0]!;
    let found = await searchStores(typed, STORES);
    // Nothing under the page's name (it may be Arabic): try the words in the link.
    for (const name of names.slice(1)) {
      if (found.offers.length > 0 && !found.approximate) break;
      const next = await searchStores(name, STORES);
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

    let error: string | null = null;
    if (results.length === 0) {
      error =
        failures.length === STORES.length
          ? "None of the stores could be reached. Please try again in a minute."
          : `Nothing close to “${typed}” was found in ${STORES.length - failures.length} Egyptian stores. Try fewer words, such as the brand and the product type.`;
    }

    // Keep a history of searches. A failed save must not hide the results.
    const { error: saveError } = await supabaseAdmin.from("price_searches").insert({
      query: data.query,
      mode: data.mode,
      status: error ? "failed" : "done",
      source: "make", // the table's label for live results
      results: error ? null : results,
      error,
    });
    if (saveError) console.error("Could not save the search:", saveError);

    if (error) return { ok: false, term, error: notice ? `${notice} ${error}` : error };
    return {
      ok: true,
      term,
      approximate,
      results,
      ...(corrected ? { typed } : {}),
      ...(notice ? { notice } : {}),
    };
  });

/** The stores currently searched: the built-in list plus the ones added by pasting a link. */
export const listStores = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ name: string; url: string }[]> => {
    const { getStores } = await import("./store-registry");
    return (await getStores()).map(({ name, url }) => ({ name, url }));
  },
);
