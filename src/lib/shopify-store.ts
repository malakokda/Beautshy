import type { CatalogItem } from "./price-results";
import type { StoreConfig } from "./stores.config";
import { getJson } from "./web";

/** Catalog pages downloaded at the same time per store. */
const PAGE_CONCURRENCY = 4;
const MAX_PAGES = 80; // 80 x 250 = 20,000 products per store

type ShopifyProduct = {
  title?: string;
  handle?: string;
  vendor?: string;
  variants?: { id?: number; title?: string; price?: string; available?: boolean }[];
  images?: { src?: string }[];
};

/** Every product of a Shopify store, from its open list at /products.json. */
export async function downloadShopifyCatalog(store: StoreConfig): Promise<CatalogItem[]> {
  const items: CatalogItem[] = [];
  for (let first = 1; first <= MAX_PAGES; first += PAGE_CONCURRENCY) {
    const pages = Array.from({ length: PAGE_CONCURRENCY }, (_, i) => first + i);
    const batches = await Promise.all(
      pages.map((page) => {
        const url = new URL("/products.json", store.url);
        url.searchParams.set("limit", "250");
        url.searchParams.set("page", String(page));
        return getJson<{ products?: ShopifyProduct[] }>(url).then((d) => d.products ?? []);
      }),
    );
    for (const products of batches) {
      for (const p of products) items.push(...productToItems(store, p));
    }
    if (batches.some((products) => products.length < 250)) break;
  }
  if (items.length === 0) throw new Error("the store's product list is empty");
  return items;
}

/** One catalog item per variant, so sizes such as 100ml and 400ml are priced separately. */
function productToItems(store: StoreConfig, p: ShopifyProduct): CatalogItem[] {
  const title = p.title?.trim();
  if (!title || !p.handle) return [];
  const productUrl = new URL(`/products/${p.handle}`, store.url).href;
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
      currency: "EGP",
      url: variant && v.id ? `${productUrl}?variant=${v.id}` : productUrl,
      ...(image ? { image } : {}),
      matchText: `${p.vendor ?? ""} ${name}`,
    });
  }
  return items;
}
