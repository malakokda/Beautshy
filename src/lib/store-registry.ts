import { readFile } from "node:fs/promises";
import path from "node:path";
import { query } from "./db";
import { takeDailyAllowance } from "./rate-limit";
import { STORES, type StoreConfig } from "./stores.config";
import { isPublicHost, siteName, tryGetJson } from "./web";

/**
 * Stores added by pasting a link into the search box. They are kept in the
 * database table "added_stores" and searched together with the built-in list
 * in stores.config.ts. Delete a store's row to remove it.
 */

/** Upper limit on stores added through the search box. */
const MAX_ADDED_STORES = 40;
/** New stores accepted per day, so one visitor cannot fill the list. */
const NEW_STORES_PER_DAY = 5;
/** How long the list is remembered before the database is asked again. */
const REMEMBER_MS = 60_000;
/** Where added stores were saved before the database existed. */
const OLD_FILE = path.join(process.cwd(), "data", "added-stores.json");

let added: { stores: StoreConfig[]; loadedAt: number } | undefined;
let oldFileImported = false;

async function loadAdded(): Promise<StoreConfig[]> {
  if (added && Date.now() - added.loadedAt < REMEMBER_MS) return added.stores;
  if (!oldFileImported) {
    await importOldFile();
    oldFileImported = true;
  }
  const rows = await query<{ name: string; url: string }>(
    `select name, url from added_stores order by created_at`,
  );
  const stores = rows.map(({ name, url }): StoreConfig => ({ name, type: "shopify", url }));
  added = { stores, loadedAt: Date.now() };
  return stores;
}

/** Copy the stores from the old data/added-stores.json into the database, once. */
async function importOldFile(): Promise<void> {
  let saved: unknown;
  try {
    saved = JSON.parse(await readFile(OLD_FILE, "utf8"));
  } catch {
    return; // no old file
  }
  for (const store of Array.isArray(saved) ? saved : []) {
    if (typeof store?.name !== "string" || typeof store?.url !== "string") continue;
    await query(`insert into added_stores (url, name) values ($1, $2) on conflict do nothing`, [
      store.url,
      store.name,
    ]);
  }
}

/** Every store to search: the built-in list plus the ones added through the search box. */
export async function getStores(): Promise<StoreConfig[]> {
  return [...STORES, ...(await loadAdded())];
}

export type StoreRegistration =
  /** The link's website is searched: it was just added, or it already was. */
  | { status: "added" | "known"; store: StoreConfig }
  /** The website cannot be searched automatically. */
  | { status: "unsupported"; site: string; reason: string };

/**
 * Make sure the website behind a link is one of the searched stores. A new
 * website is added when it is an Egyptian Shopify store with an open product
 * list and prices in Egyptian pounds.
 */
export async function registerStoreFromLink(url: URL): Promise<StoreRegistration> {
  const site = siteName(url.hostname);
  const sameSite = (s: StoreConfig) => siteName(new URL(s.url).hostname) === site;
  const known = (await getStores()).find(sameSite);
  if (known) return { status: "known", store: known };

  const unsupported = (reason: string): StoreRegistration => ({
    status: "unsupported",
    site,
    reason,
  });
  if (url.protocol !== "https:" || !(await isPublicHost(url.hostname))) {
    return unsupported("its address is not a public https website");
  }
  if ((await loadAdded()).length >= MAX_ADDED_STORES) {
    return unsupported(`the limit of ${MAX_ADDED_STORES} added stores is reached`);
  }

  const shop = await tryGetJson<{ name?: string; currency?: string; country?: string }>(
    new URL("/meta.json", url.origin),
  );
  const feed = await tryGetJson<{ products?: unknown[] }>(
    new URL("/products.json?limit=1", url.origin),
  );
  if (!shop?.currency || !Array.isArray(feed?.products) || feed.products.length === 0) {
    return unsupported("it does not share an open product list (only Shopify stores do)");
  }
  if (shop.currency !== "EGP" || (shop.country && shop.country !== "EG")) {
    return unsupported(
      shop.currency !== "EGP"
        ? `its prices are in ${shop.currency}, not Egyptian pounds`
        : "it is not an Egyptian store",
    );
  }
  if (!(await takeDailyAllowance("added-stores", NEW_STORES_PER_DAY))) {
    return unsupported(`only ${NEW_STORES_PER_DAY} new stores can be added per day`);
  }

  const store: StoreConfig = {
    name: shop.name?.trim().slice(0, 60) || site,
    type: "shopify",
    url: url.origin,
  };
  // If another search added the same store meanwhile, the row already exists.
  await query(`insert into added_stores (url, name) values ($1, $2) on conflict do nothing`, [
    store.url,
    store.name,
  ]);
  added = undefined; // read the list again next time
  console.info(`[store-registry] added ${store.name} (${store.url})`);
  return { status: "added", store };
}
