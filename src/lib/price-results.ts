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

/** Sort offers cheapest-first and keep only the top TOP_N. */
export function topCheapest(offers: Offer[]): Offer[] {
  return [...offers]
    .filter((o) => Number.isFinite(o.price) && o.price >= 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, TOP_N);
}
