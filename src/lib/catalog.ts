/**
 * The stores' products. Server-only.
 *
 * The database holds one shared copy of every store's product list. A store is
 * read from its website again when its copy is older than 6 hours, by whichever
 * server notices first; the others see that it is being handled and leave it.
 *
 * Each server also keeps the products in memory, prepared for searching, and
 * checks the database once a minute for stores that have a newer copy. So a
 * search never waits for a store's website, and a restarted server is ready
 * as soon as it has loaded the copy from the database.
 */
import { query } from "./db";
import { buildIndex, type Index } from "./fuzzy-match";
import type { CatalogItem, Offer } from "./price-results";
import { downloadShopifyCatalog } from "./shopify-store";
import { downloadSitemapCatalog } from "./sitemap-store";
import type { StoreConfig } from "./stores.config";
import { CACHE_TTL_MS } from "./web";

/** How often a server checks the database for newer product lists. */
const SYNC_EVERY_MS = 60_000;
/** How long one server may take to read a store before another may try. */
const CLAIM_MINUTES = 10;
const ROWS_PER_INSERT = 1_000;

/** What this server has in memory: store address -> its products, ready to search. */
const loaded = new Map<string, { batch: string; index: Index<Offer> }>();
/** Stores this server is reading from their websites right now. */
const refreshing = new Map<string, Promise<void>>();
/** Why a store's last read failed, if it did. */
const errors = new Map<string, string>();
/** Stores already compared with the database, and when that last happened. */
const checked = new Set<string>();
let lastSync = 0;
let syncing: Promise<void> | undefined;

export type StoreIndexes = {
  indexes: Index<Offer>[];
  /** Stores with no products available, with the reason. */
  failures: { store: string; reason: string }[];
};

/** The searchable products of the given stores (not Amazon, which is searched live). */
export async function getStoreIndexes(stores: StoreConfig[]): Promise<StoreIndexes> {
  const due = Date.now() - lastSync >= SYNC_EVERY_MS || stores.some((s) => !checked.has(s.url));
  if (due) {
    syncing ??= sync(stores).finally(() => (syncing = undefined));
    await syncing;
  }
  // A store this server is reading for the very first time: wait for it once.
  await Promise.all(stores.filter((s) => !loaded.has(s.url)).map((s) => refreshing.get(s.url)));

  const result: StoreIndexes = { indexes: [], failures: [] };
  for (const store of stores) {
    const have = loaded.get(store.url);
    if (have) result.indexes.push(have.index);
    else {
      const reason = errors.get(store.url) ?? "its products are still being loaded";
      result.failures.push({ store: store.name, reason });
    }
  }
  return result;
}

type RefreshRow = {
  store_url: string;
  batch: string | null;
  age_seconds: number | null;
  error: string | null;
};

/** Bring this server's memory in line with the database, and refresh stale stores. */
async function sync(stores: StoreConfig[]): Promise<void> {
  const rows = await query<RefreshRow>(
    `select store_url, batch, error,
            extract(epoch from now() - refreshed_at)::float8 as age_seconds
       from store_refresh`,
  );
  const byUrl = new Map(rows.map((row) => [row.store_url, row]));
  await Promise.all(
    stores.map(async (store) => {
      const row = byUrl.get(store.url);
      if (row?.batch && loaded.get(store.url)?.batch !== row.batch) {
        await loadFromDatabase(store, row.batch);
      }
      if (row?.error) errors.set(store.url, row.error);
      else errors.delete(store.url);
      const stale = !row || row.age_seconds === null || row.age_seconds * 1000 > CACHE_TTL_MS;
      if (stale) startRefresh(store);
      checked.add(store.url);
    }),
  );
  lastSync = Date.now();
}

type ProductRow = {
  name: string;
  match_text: string;
  price: number | null;
  url: string;
  image: string | null;
};

async function loadFromDatabase(store: StoreConfig, batch: string): Promise<void> {
  const rows = await query<ProductRow>(
    `select name, match_text, price, url, image from products
      where store_url = $1 and batch = $2`,
    [store.url, batch],
  );
  remember(
    store,
    batch,
    rows.map((row) => ({
      store: store.name,
      name: row.name,
      price: row.price ?? Number.NaN, // sitemap stores: read from the page later
      currency: "EGP",
      url: row.url,
      ...(row.image ? { image: row.image } : {}),
      matchText: row.match_text,
    })),
  );
}

function remember(store: StoreConfig, batch: string, items: CatalogItem[]): void {
  const index = buildIndex(
    items.map(({ matchText, ...offer }) => ({ item: offer as Offer, text: matchText })),
  );
  loaded.set(store.url, { batch, index });
}

function startRefresh(store: StoreConfig): void {
  if (refreshing.has(store.url)) return;
  const work = refresh(store)
    .catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      errors.set(store.url, reason);
      console.error(`[catalog] ${store.name} could not be refreshed:`, reason);
    })
    .finally(() => refreshing.delete(store.url));
  refreshing.set(store.url, work);
}

/** Read a store from its website and replace its products in the database. */
async function refresh(store: StoreConfig): Promise<void> {
  // Take the job only if the copy is stale and no other server took it recently.
  const claimed = await query(
    `insert into store_refresh (store_url, claimed_at) values ($1, now())
     on conflict (store_url) do update set claimed_at = now()
       where (store_refresh.claimed_at is null
              or store_refresh.claimed_at < now() - make_interval(mins => $2::int))
         and (store_refresh.refreshed_at is null
              or store_refresh.refreshed_at < now() - make_interval(secs => $3::float8))
     returning store_url`,
    [store.url, CLAIM_MINUTES, CACHE_TTL_MS / 1000],
  );
  if (claimed.length === 0) return;

  try {
    const items =
      store.type === "sitemap"
        ? await downloadSitemapCatalog(store)
        : await downloadShopifyCatalog(store);
    const batch = String(Date.now());
    for (let i = 0; i < items.length; i += ROWS_PER_INSERT) {
      await query(
        `insert into products (store_url, batch, name, match_text, price, url, image)
         select $1, $2, r.name, r."matchText", r.price, r.url, r.image
           from jsonb_to_recordset($3::jsonb)
             as r(name text, "matchText" text, price float8, url text, image text)`,
        [store.url, batch, JSON.stringify(items.slice(i, i + ROWS_PER_INSERT))],
      );
    }
    // Switch to the new copy, then remove the old one.
    await query(
      `update store_refresh
          set batch = $2, refreshed_at = now(), claimed_at = null, error = null, product_count = $3
        where store_url = $1`,
      [store.url, batch, items.length],
    );
    await query(`delete from products where store_url = $1 and batch <> $2`, [store.url, batch]);
    remember(store, batch, items);
    errors.delete(store.url);
  } catch (err) {
    // The old copy keeps answering searches; the claim lapses and it is tried again later.
    const reason = err instanceof Error ? err.message : String(err);
    await query(`update store_refresh set error = $2 where store_url = $1`, [
      store.url,
      reason,
    ]).catch(() => {});
    throw err;
  }
}
