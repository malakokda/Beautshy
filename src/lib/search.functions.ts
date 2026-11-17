import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { FREE_SEARCHES } from "./plans";
import type { Offer } from "./price-results";

const searchInput = z.object({
  /** A product name, or a link to a product or a store. */
  query: z.string().trim().min(2).max(500),
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
  | {
      ok: false;
      term: string;
      error: string;
      /** What the visitor has to do before they can search. */
      needs?: "sign-in" | "upgrade";
    };

/**
 * Runs on the server when the page asks for a search. It checks the visitor
 * is signed in and still has searches on their plan, then runs the search
 * (see search.ts). A search that returns no results is not counted.
 */
export const searchPrices = createServerFn({ method: "POST" })
  .inputValidator((data) => searchInput.parse(data))
  .handler(async ({ data }): Promise<SearchResponse> => {
    // Server-only modules are loaded here so they never reach the browser.
    const [{ getRequestIP }, { allowAction }, accounts, { runSearch }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./rate-limit"),
      import("./accounts"),
      import("./search"),
    ]);
    const refuse = (error: string, needs?: "sign-in" | "upgrade"): SearchResponse => ({
      ok: false,
      term: data.query,
      error,
      ...(needs ? { needs } : {}),
    });

    // Stop one visitor from flooding the stores with searches.
    if (!allowAction(getRequestIP({ xForwardedFor: true }) ?? "unknown")) {
      return refuse("Too many searches at once. Please wait a minute and try again.");
    }

    // Searching needs an account, and a free account has a limited number of searches.
    const user = accounts.currentUser();
    if (!user) return refuse("Please sign in to search.", "sign-in");
    let reservation: Awaited<ReturnType<typeof accounts.reserveSearch>>;
    try {
      reservation = await accounts.reserveSearch(user);
    } catch (err) {
      console.error("[search] could not check the account:", err);
      return refuse("Your account could not be checked right now. Please try again later.");
    }
    if (!reservation.allowed) {
      return refuse(`You have used your ${FREE_SEARCHES} free searches.`, "upgrade");
    }

    const response = await runSearch(data.query);
    if (!response.ok || response.results.length === 0) await reservation.refund();
    return response;
  });

/** The stores currently searched: the built-in list plus the ones added by pasting a link. */
export const listStores = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ name: string; url: string }[]> => {
    const { getStores } = await import("./store-registry");
    return (await getStores()).map(({ name, url }) => ({ name, url }));
  },
);
