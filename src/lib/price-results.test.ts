import { describe, expect, it } from "vitest";
import { topCheapest, type Offer } from "./price-results";

const offer = (price: number, url: string, image?: string): Offer => ({
  store: "Shop",
  name: `Item ${price}`,
  price,
  currency: "EGP",
  url,
  ...(image ? { image } : {}),
});

describe("topCheapest", () => {
  it("sorts cheapest first and keeps ten", () => {
    const offers = Array.from({ length: 15 }, (_, i) => offer(100 - i, `https://shop.test/${i}`));
    const top = topCheapest(offers);
    expect(top).toHaveLength(10);
    expect(top[0]!.price).toBe(86);
  });

  it("drops links and pictures that are not ordinary web addresses", () => {
    const top = topCheapest([
      offer(10, "javascript:alert(document.cookie)"),
      offer(20, "JavaScript:alert(1)"),
      offer(30, "data:text/html,<script>alert(1)</script>"),
      offer(40, "https://shop.test/ok", "javascript:alert(1)"),
      offer(50, "https://shop.test/ok2", "https://cdn.shop.test/a.jpg"),
    ]);
    expect(top.map((o) => o.price)).toEqual([40, 50]);
    expect(top[0]!.image).toBeUndefined();
    expect(top[1]!.image).toBe("https://cdn.shop.test/a.jpg");
  });
});
