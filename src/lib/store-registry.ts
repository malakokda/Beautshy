import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STORES, type StoreConfig } from "./stores.config";
import { takeDailyAllowance } from "./rate-limit";
import { isPublicHost, siteName, tryGetJson } from "./web";

/**
 * Stores added by pasting a link into the search box. They are searched
 * together with the built-in list in stores.config.ts.
 *
 * They are saved in the database table "added_stores" (see supabase/schema.sql),
 * so they survive restarts on any hosting service. Until that table exists
 * they are saved in data/added-stores.json instead, which only lasts on a
 * computer that keeps its files. Delete a store's row (or entry) to remove it.
 */
const FILE = path.join(process.cwd(), "data", "added-stores.json");
/** Upper limit on stores added through the search box. */
const MAX_ADDED_STORES = 40;
/** New stores accepted per day, so one visitor cannot fill the list. */
const NEW_STORES_PER_DAY = 5;

let added: StoreConfig[] | undefined;
/** Turned off when the database table cannot be used; the file is used instead. */
let useDatabase = true;

async function loadAdded(): Promise<StoreConfig[]> {
  if (added) return added;
  const fromFile = await readFileStores();
  try {
    const { data, error } = await supabaseAdmin.from("added_stores").select("name, url");
    if (error) throw new Error(error.message);
    const list: StoreConfig[] = data.map(({ name, url }) => ({ name, type: "shopify", url }));
    // Move over the stores that were saved in the file before the table existed.
    const missing = fromFile.filter((f) => !list.some((s) => s.url === f.url));
    if (missing.length > 0) {
      const moved = await supabaseAdmin
        .from("added_stores")
        .insert(missing.map(({ name, url }) => ({ name, url })));
      if (moved.error) console.warn("[store-registry] could not move file stores:", moved.error);
      list.push(...missing);
    }
    added = list;
  } catch (err) {
    useDatabase = false;
    console.warn(
      "[store-registry] the added_stores table is not available, using data/added-stores.json. " +
        "Run supabase/schema.sql in Supabase to keep added stores when the site is hosted.",
      err,
    );
    added = fromFile;
  }
  return added;
}

async function readFileStores(): Promise<StoreConfig[]> {
  try {
    const saved: unknown = JSON.parse(await readFile(FILE, "utf8"));
    return Array.isArray(saved)
      ? saved.filter(
          (s): s is StoreConfig =>
            typeof s?.name === "string" && typeof s?.url === "string" && s?.type === "shopify",
        )
      : [];
  } catch {
    return []; // no file yet
  }
}

async function saveAdded(store: StoreConfig, all: StoreConfig[]): Promise<void> {
  if (useDatabase) {
    const { error } = await supabaseAdmin
      .from("added_stores")
      .insert({ name: store.name, url: store.url });
    if (!error) return;
    console.warn("[store-registry] could not save to the database, saving to the file:", error);
  }
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, `${JSON.stringify(all, null, 2)}\n`, "utf8");
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
 * website is added when it is a Shopify store with an open product list and
 * prices in Egyptian pounds.
 */
export async function registerStoreFromLink(url: URL): Promise<StoreRegistration> {
  const site = siteName(url.hostname);
  const stores = await getStores();
  const known = stores.find((s) => siteName(new URL(s.url).hostname) === site);
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
  if (!takeDailyAllowance("added-stores", NEW_STORES_PER_DAY)) {
    return unsupported(`only ${NEW_STORES_PER_DAY} new stores can be added per day`);
  }

  const store: StoreConfig = {
    name: shop.name?.trim().slice(0, 60) || site,
    type: "shopify",
    url: url.origin,
  };
  const list = await loadAdded();
  // Another search may have added the same store while this one was checking it.
  const raced = list.find((s) => siteName(new URL(s.url).hostname) === site);
  if (raced) return { status: "known", store: raced };
  list.push(store);
  await saveAdded(store, list);
  console.info(`[store-registry] added ${store.name} (${store.url})`);
  return { status: "added", store };
}
