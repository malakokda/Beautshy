import { describe, expect, it } from "vitest";
import { findBestMatches, typoDistance, wordSet, type Vocabulary } from "./fuzzy-match";

const PRODUCTS = [
  "Garnier Micellar Water 400ml",
  "Garnier Micellar Water 100ml",
  "Garnier Vitamin C Serum 30ml",
  "CeraVe Foaming Cleanser 236ml",
  "CeraVe Hydrating Cleanser 236ml",
  "CeraVe Moisturizing Cream 340g",
  "Neutrogena Hydro Boost Water Gel 50g",
  "L'Oreal Paris Revitalift Serum",
  "Bioderma Sebium Sebio-Control Cream",
  "Maybelline Fit Me Makeup Foundation",
  // Filler so the real brand names count as common words.
  ...Array.from({ length: 5 }, (_, i) => `Garnier Hair Color Shade ${i}`),
  ...Array.from({ length: 5 }, (_, i) => `CeraVe Lotion Type ${i}`),
];

function search(query: string) {
  const vocabulary: Vocabulary = new Map();
  const entries = PRODUCTS.map((name) => ({ item: name, words: wordSet(name, vocabulary) }));
  return findBestMatches(query, entries, [vocabulary]);
}

describe("typoDistance", () => {
  it("counts wrong, missing, extra and swapped letters", () => {
    expect(typoDistance("garnir", "garnier", 2)).toBe(1);
    expect(typoDistance("cearve", "cerave", 2)).toBe(1);
    expect(typoDistance("nutrogina", "neutrogena", 2)).toBe(2);
    expect(typoDistance("serum", "cream", 2)).toBe(3);
  });
});

describe("findBestMatches", () => {
  it("finds the exact product", () => {
    const res = search("Garnier Micellar Water 400 ml");
    expect(res.matches).toEqual(["Garnier Micellar Water 400ml"]);
    expect(res.approximate).toBe(false);
    expect(res.corrected).toBeNull();
  });

  it("forgives spelling mistakes and reports the fixed spelling", () => {
    const res = search("garnir micelar watr");
    expect(res.matches).toEqual(["Garnier Micellar Water 400ml", "Garnier Micellar Water 100ml"]);
    expect(res.corrected).toBe("garnier micellar water");
    expect(res.approximate).toBe(false);
  });

  it("accepts half-typed names", () => {
    expect(search("cerav clean").corrected).toBe("cerave cleanser");
    expect(search("cerav clean").matches).toEqual([
      "CeraVe Foaming Cleanser 236ml",
      "CeraVe Hydrating Cleanser 236ml",
    ]);
    expect(search("neutrogina hydro").matches).toEqual(["Neutrogena Hydro Boost Water Gel 50g"]);
  });

  it("treats split, joined and plural spellings alike", () => {
    expect(search("loreal serums").matches).toEqual(["L'Oreal Paris Revitalift Serum"]);
    expect(search("sebiocontrol").matches).toEqual(["Bioderma Sebium Sebio-Control Cream"]);
    expect(search("maybelline make up").matches).toEqual(["Maybelline Fit Me Makeup Foundation"]);
  });

  it("never guesses sizes", () => {
    expect(search("garnier micellar 100ml").matches).toEqual(["Garnier Micellar Water 100ml"]);
  });

  it("falls back to the closest products when nothing has the whole name", () => {
    const res = search("cerave moisturizing cream 999g");
    expect(res.matches).toEqual(["CeraVe Moisturizing Cream 340g"]);
    expect(res.approximate).toBe(true);
  });

  it("returns nothing for an unrelated search", () => {
    expect(search("zzzz qqqq").matches).toEqual([]);
    expect(search("400ml").matches).toEqual(["Garnier Micellar Water 400ml"]);
    expect(search("xyzzy 400ml").matches).toEqual([]);
  });
});
