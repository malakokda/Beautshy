/** One product offer from one store. Shared by the server search and the page. */
export type Offer = {
  store: string;
  name: string;
  price: number;
  currency: string;
  url: string;
  image?: string;
};

/** An offer plus the text used to match it (brand + product name + size/variant). */
export type CatalogItem = Offer & { matchText: string };

/** How many of the cheapest offers are kept for every search. */
const TOP_N = 10;

/** True for ordinary web addresses. Anything else (e.g. "javascript:") could run code when clicked. */
export function isWebAddress(address: string | undefined): address is string {
  if (!address) return false;
  try {
    const { protocol } = new URL(address);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Sort offers cheapest-first and keep only the top TOP_N. Offers come from
 * other websites, so any link or picture that is not an ordinary web address
 * is dropped here, before it reaches the page.
 */
export function topCheapest(offers: Offer[]): Offer[] {
  return [...offers]
    .filter((o) => Number.isFinite(o.price) && o.price >= 0 && isWebAddress(o.url))
    .map(({ image, ...offer }) => (isWebAddress(image) ? { ...offer, image } : offer))
    .sort((a, b) => a.price - b.price)
    .slice(0, TOP_N);
}
