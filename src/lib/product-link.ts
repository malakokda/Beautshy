import type { Offer } from "./price-results";
import { download, findJsonLdProduct, isPublicHost, siteName, tryGetJson } from "./web";

const PAGE_TIMEOUT_MS = 8_000;
const MAX_PAGE_BYTES = 3_000_000;
/** Link path parts that are never the product name. */
const GENERIC_SEGMENTS = new Set([
  "products",
  "product",
  "p",
  "dp",
  "catalog",
  "item",
  "items",
  "shop",
  "collections",
  "en",
  "ar",
  "egypt-en",
  "egypt-ar",
]);
/** Sites known to refuse automated page requests: read the name from the link instead. */
const NAME_FROM_LINK_ONLY = /(^|\.)(jumia\.com\.eg|noon\.com|amazon\.eg|amazon\.com)$/i;

export type LinkedProduct = {
  /**
   * Names to search for, best first: the name on the page, then the words in
   * the link (often English when the page name is Arabic).
   */
  names: string[];
  /** The linked product's own price, when the link is to a Shopify store. */
  offer?: Offer;
  /** True when the linked product is sold out at its own store. */
  outOfStock?: boolean;
};

/**
 * Work out the product behind a product link. Reads the page (Shopify
 * product data, structured product info, share title, page title) and falls
 * back to the words in the link itself.
 */
export async function productFromLink(url: URL): Promise<LinkedProduct> {
  const linkWords = nameFromUrlWords(url);

  let name: string | undefined;
  let offer: Offer | undefined;
  let outOfStock = false;
  if (!NAME_FROM_LINK_ONLY.test(url.hostname) && (await isPublicHost(url.hostname))) {
    try {
      const shopify = await readShopifyProduct(url);
      name = shopify?.name ?? (await nameFromPage(url));
      offer = shopify?.offer;
      outOfStock = shopify?.outOfStock ?? false;
    } catch (err) {
      console.warn("[product-link] could not read the page, using the link words:", err);
    }
  }
  const names = name ? [name] : [];
  if (linkWords !== url.href && !names.some((n) => n.toLowerCase() === linkWords.toLowerCase())) {
    names.push(linkWords);
  }
  if (names.length === 0) names.push(linkWords);
  return { names, ...(offer ? { offer } : {}), ...(outOfStock ? { outOfStock } : {}) };
}

type ShopifyProductJs = {
  title?: string;
  available?: boolean;
  featured_image?: string;
  /** Prices are in hundredths: 25000 = 250.00 */
  variants?: { price?: number; available?: boolean }[];
};

/** Shopify stores expose every product as /products/<handle>.js */
async function readShopifyProduct(
  url: URL,
): Promise<{ name: string; offer?: Offer; outOfStock?: boolean } | undefined> {
  const match = url.pathname.match(/\/products\/([^/?#]+)/);
  if (!match) return undefined;
  const data = await tryGetJson<ShopifyProductJs>(new URL(`/products/${match[1]}.js`, url.origin));
  const name = cleanTitle(data?.title);
  if (!data || !name) return undefined;

  const prices = (data.variants ?? [])
    .filter((v) => v.available !== false && typeof v.price === "number" && v.price > 0)
    .map((v) => v.price! / 100);
  if (data.available === false || prices.length === 0) return { name, outOfStock: true };

  // The store's own name and currency; guessed from the address if unavailable.
  const shop = await tryGetJson<{ name?: string; currency?: string }>(
    new URL("/meta.json", url.origin),
  );
  const image = data.featured_image ? new URL(data.featured_image, url.origin).href : undefined;
  return {
    name,
    offer: {
      store: shop?.name?.trim() || siteName(url.hostname),
      name: name.slice(0, 300),
      price: Math.min(...prices),
      currency: shop?.currency ?? "EGP",
      url: new URL(`/products/${match[1]}`, url.origin).href,
      ...(image ? { image } : {}),
    },
  };
}

async function nameFromPage(url: URL): Promise<string | undefined> {
  const res = await download(url, {
    accept: "text/html",
    timeoutMs: PAGE_TIMEOUT_MS,
    maxBytes: MAX_PAGE_BYTES,
  });
  if (res.status < 200 || res.status >= 300 || !res.contentType.includes("html")) return undefined;
  const html = res.body;

  // 1. Structured product data (schema.org Product)
  const product = findJsonLdProduct(html);
  if (typeof product?.["name"] === "string") return cleanTitle(product["name"]);
  // 2. Share title, 3. <h1>, 4. <title>
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ");
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return cleanTitle(og) ?? cleanTitle(h1) ?? cleanTitle(title);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/** Decode HTML entities, drop " | Store name" style suffixes, tidy spaces. */
function cleanTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) =>
      e[0] === "#"
        ? String.fromCodePoint(
            e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
          )
        : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .split(/\s[|–—]\s/)[0]!
    .replace(/\s+/g, " ")
    .replace(/^["\s]+|["\s]+$/g, ""); // some stores wrap the name in quote marks
  return text.length >= 2 ? text.slice(0, 200) : undefined;
}

/**
 * Pick the path segment that looks like a product name, e.g.
 *   /products/garnier-micellar-water-400ml           -> "garnier micellar water 400ml"
 *   /Garnier-Micellar-Water/dp/B07XYZ                -> "Garnier Micellar Water"
 *   /garnier-micellar-water-100ml-25092249.html      -> "garnier micellar water 100ml"
 */
function nameFromUrlWords(url: URL): string {
  const segments = url.pathname
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .map((s) => s.replace(/\.(html?|php|aspx?)$/i, ""));
  let best = "";
  let bestWords = 0;
  for (const segment of segments) {
    const words = segment
      .split(/[-_+\s]+/)
      .filter((w) => w && !/^(mpg)?\d{5,}$/i.test(w) && !/^[A-Z0-9]{10}$/.test(w));
    if (GENERIC_SEGMENTS.has(segment.toLowerCase())) continue;
    const letterWords = words.filter((w) => /\p{L}{2,}/u.test(w)).length;
    if (letterWords > bestWords) {
      bestWords = letterWords;
      best = words.join(" ");
    }
  }
  return best || url.href;
}
