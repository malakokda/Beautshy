import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogItem } from "./price-results";
import type { StoreConfig } from "./stores.config";

// The stores' websites are replaced by a list we control. The database is real:
// an in-memory Postgres, so the SQL in catalog.ts and rate-limit.ts is exercised.
const website = vi.hoisted(() => ({ items: [] as CatalogItem[], downloads: 0, down: false }));
vi.mock("./shopify-store", () => ({
  downloadShopifyCatalog: vi.fn(async () => {
    website.downloads++;
    if (website.down) throw new Error("HTTP 503");
    return website.items;
  }),
}));

import { getStoreIndexes } from "./catalog";
import { query } from "./db";
import { takeDailyAllowance } from "./rate-limit";
import { searchStores } from "./store-search";

let store: StoreConfig;
let storeNumber = 0;
const item = (name: string, price: number): CatalogItem => ({
  store: store.name,
  name,
  price,
  currency: "EGP",
  url: `${store.url}/products/${name.toLowerCase().replace(/\W+/g, "-")}`,
  matchText: name,
});

beforeEach(() => {
  // A new store each time, so one test's products never reach the next.
  storeNumber++;
  store = { name: `Shop ${storeNumber}`, type: "shopify", url: `https://shop${storeNumber}.test` };
  website.downloads = 0;
  website.down = false;
  website.items = [item("Garnier Micellar Water 400ml", 350), item("CeraVe Cleanser", 620)];
});

describe("store products", () => {
  it("reads a new store once, saves it, and searches it", async () => {
    const found = await searchStores("garnir micelar watr", [store]);
    expect(found.offers.map((o) => o.name)).toEqual(["Garnier Micellar Water 400ml"]);
    expect(found.offers[0]!.price).toBe(350);
    expect(found.corrected).toBe("garnier micellar water");
    expect(found.failures).toEqual([]);

    const saved = await query<{ n: number }>(
      `select count(*)::int as n from products where store_url = $1`,
      [store.url],
    );
    expect(saved[0]!.n).toBe(2);

    await searchStores("cerave", [store]);
    expect(website.downloads).toBe(1); // the second search did not go back to the store
  });

  it("replaces a store's products when its copy is older than 6 hours", async () => {
    await getStoreIndexes([store]);
    website.items = [item("Nivea Soft Cream", 120)];
    await query(
      `update store_refresh set refreshed_at = now() - interval '7 hours' where store_url = $1`,
      [store.url],
    );
    // Pretend a minute has passed, so the server checks the database again.
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    await getStoreIndexes([store]); // serves the old copy and starts the refresh
    vi.useRealTimers();
    await vi.waitFor(async () => {
      const names = await query<{ name: string }>(
        `select name from products where store_url = $1`,
        [store.url],
      );
      expect(names.map((row) => row.name)).toEqual(["Nivea Soft Cream"]);
    });
    expect(website.downloads).toBe(2);
    expect((await searchStores("nivea", [store])).offers).toHaveLength(1);
    expect((await searchStores("garnier", [store])).offers).toHaveLength(0);
  });

  it("reports a store whose website cannot be read", async () => {
    website.down = true;
    const found = await searchStores("garnier", [store]);
    expect(found.offers).toEqual([]);
    expect(found.failures).toEqual([{ store: store.name, reason: "HTTP 503" }]);
  });

  it("does not read a store another server has just claimed", async () => {
    await query(`insert into store_refresh (store_url, claimed_at) values ($1, now())`, [
      store.url,
    ]);
    const found = await getStoreIndexes([store]);
    expect(website.downloads).toBe(0);
    expect(found.failures).toHaveLength(1);
  });
});

describe("daily limits", () => {
  it("allows exactly the limit per day, even when asked all at once", async () => {
    const answers = await Promise.all(Array.from({ length: 8 }, () => takeDailyAllowance("t", 5)));
    expect(answers.filter(Boolean)).toHaveLength(5);
    expect(await takeDailyAllowance("t", 5)).toBe(false);
    expect(await takeDailyAllowance("other", 5)).toBe(true);
  });
});
