/**
 * The Egyptian stores the app searches. Edit this list to add or remove stores.
 *
 * type:
 *   - "shopify": any store built on Shopify (most Egyptian beauty shops).
 *     Check a site by opening  https://<site>/search/suggest.json?q=test
 *     in your browser. If you see JSON with "products", it works.
 *   - "amazon": Amazon, searched through SerpAPI (needs SERPAPI_KEY in
 *     .env.local; each search uses one SerpAPI credit, reused for 6 hours).
 *   - "sitemap": a store that is not on Shopify but lists its product pages
 *     in a sitemap and states the price inside each page (Mazaya, Faces).
 *     sitemap:        address of the sitemap (see the store's /robots.txt).
 *     productPattern: what a product page address looks like (a regular expression).
 *
 * url:      the store's home page, without a trailing slash.
 * currency: what the store's prices are in (defaults to "EGP").
 */
export type StoreConfig = {
  name: string;
  url: string;
  currency?: string;
} & ({ type: "shopify" | "amazon" } | { type: "sitemap"; sitemap: string; productPattern: string });

export const STORES: StoreConfig[] = [
  { name: "Amazon Egypt", type: "amazon", url: "https://www.amazon.eg" },
  { name: "Cairo Megastore", type: "shopify", url: "https://www.cairomegastore.com" },
  { name: "Loolia Closet", type: "shopify", url: "https://eg.looliacloset.com" },
  { name: "Bashrety", type: "shopify", url: "https://bashrety.tv" },
  { name: "Dr. Dawood Store", type: "shopify", url: "https://drdawoodstore.com" },
  { name: "Feel22 Egypt", type: "shopify", url: "https://eg.feel22.com" },
  { name: "Source Beauty", type: "shopify", url: "https://sourcebeauty.com" },
  { name: "Bloom Pharmacy", type: "shopify", url: "https://bloompharmacy.com" },
  { name: "Zynah", type: "shopify", url: "https://zynah.me" },
  { name: "Trindiva", type: "shopify", url: "https://trindiva.com" },
  { name: "Sofie Store", type: "shopify", url: "https://sofiestore.net" },
  { name: "Korean Beautys", type: "shopify", url: "https://koreanbeautys.com" },
  { name: "Taksima", type: "shopify", url: "https://taksima.com" },
  { name: "Braes", type: "shopify", url: "https://braes.co" },
  { name: "Areej Aromatherapy", type: "shopify", url: "https://areejaromatherapy.com" },
  { name: "The Bath Land", type: "shopify", url: "https://thebathland.com" },
  { name: "AM Cosmetics", type: "shopify", url: "https://amcosmeticseg.com" },
  { name: "Maison Nari", type: "shopify", url: "https://maisonnari.com" },
  {
    name: "Mazaya",
    type: "sitemap",
    url: "https://mazaya.eg",
    sitemap: "https://mazaya.eg/en-sitemap.xml",
    productPattern: "^https://mazaya\\.eg/en/[^/]+$",
  },
  {
    name: "Faces",
    type: "sitemap",
    url: "https://www.faces.eg",
    sitemap: "https://www.faces.eg/en/sitemap_index.xml",
    productPattern: "^https://www\\.faces\\.eg/en/p/[^/]+\\.html$",
  },
  { name: "Infinity Clinic Pharma", type: "shopify", url: "https://www.infinityclinicpharma.com" },
];
