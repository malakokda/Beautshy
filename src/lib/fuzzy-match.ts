/**
 * Forgiving product-name matching: finds the most suitable products even when
 * the search is misspelled ("garnir micelar") or only part of the name ("cerav clean").
 *
 * How a search word can match a product word, best first:
 *   1.00  same word                      cerave    = CeraVe
 *   0.95  singular / plural              cleansers = cleanser
 *   0.90  start of the word              micel     = micellar
 *   0.80  one typo                       garnir    = garnier
 *   0.70  two typos (longer words only)  nutrogina = neutrogena
 * Sizes and numbers ("400ml", "50") are never guessed: they must be the same.
 */

const SIZE_UNITS = "ml|l|g|gm|gr|kg|mg|oz";
/** Joining words that do not have to appear in the product name. */
const IGNORED_WORDS = new Set(["and", "with", "for", "of", "the", "in", "Ùˆ", "Ù…Ø¹"]);

const QUALITY_PLURAL = 0.95;
const QUALITY_PREFIX = 0.9;
const QUALITY_ONE_TYPO = 0.8;
const QUALITY_TWO_TYPOS = 0.7;
/** Products scoring this far below the best match are dropped. */
const SCORE_BAND = 0.15;

/**
 * Lower-case, drop accents and write sizes as "400ml". Hyphens and apostrophes
 * separate words ("Sebio-Control" -> "sebio control"); the joined spelling is
 * accepted too when matching (see wordSet).
 */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/Ù…Ù„/g, "ml")
    .replace(/Ø¬Ù…|Ø¬Ø±Ø§Ù…/g, "g")
    .replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${SIZE_UNITS})\\b`, "g"), "$1$2")
    .replace(/\b(\d+(?:\.\d+)?)(gm|gr)\b/g, "$1g");
}

export function tokens(text: string): string[] {
  return (
    normalize(text)
      .match(/[\p{L}\p{N}]+(?:\.\d+)?/gu)
      ?.filter((t) => !IGNORED_WORDS.has(t)) ?? []
  );
}

/** How often each word appears in the stores' product names. */
type Vocabulary = Map<string, number>;

/**
 * A set of products prepared for searching. `postings` lists, for every word,
 * the products whose name contains it, so a search only looks at products that
 * share a word with it instead of reading every product.
 */
export type Index<T> = {
  items: T[];
  vocabulary: Vocabulary;
  /** word -> positions in `items` of the products that have it */
  postings: Map<string, number[]>;
};

/** Prepare products for searching. `text` is what a product is matched on. */
export function buildIndex<T>(entries: { item: T; text: string }[]): Index<T> {
  const vocabulary: Vocabulary = new Map();
  const postings = new Map<string, number[]>();
  entries.forEach(({ text }, position) => {
    const words = tokens(text);
    const unique = new Set(words);
    for (const word of unique) vocabulary.set(word, (vocabulary.get(word) ?? 0) + 1);
    // Every pair of neighbouring words is also stored joined, so "Sebio-Control"
    // answers to "sebiocontrol" and "make up" to "makeup".
    for (let i = 0; i + 1 < words.length; i++) unique.add(words[i]! + words[i + 1]!);
    for (const word of unique) {
      const list = postings.get(word);
      if (list) list.push(position);
      else postings.set(word, [position]);
    }
  });
  return { items: entries.map((e) => e.item), vocabulary, postings };
}

/** Typos allowed for a word of this length. Short words are too easy to confuse. */
function typoLimit(length: number): number {
  if (length < 4) return 0;
  return length < 7 ? 1 : 2;
}

/**
 * Number of typos between two words: a wrong, missing or extra letter, or two
 * neighbouring letters swapped, each count as one. Returns limit + 1 when over.
 */
export function typoDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous2: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] === b[j - 1];
      let cost = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (same ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, previous2[j - 2]! + 1);
      }
      current.push(cost);
      if (cost < rowBest) rowBest = cost;
    }
    if (rowBest > limit) return limit + 1;
    previous2 = previous;
    previous = current;
  }
  return Math.min(previous[b.length]!, limit + 1);
}

type ExpandedToken = {
  token: string;
  /** Product words accepted for this search word, with how good each one is. */
  variants: Map<string, number>;
  /** True when no store uses this word as typed: it is misspelled or half-typed. */
  unknown: boolean;
};

/** Work out which product words each search word may stand for. */
function expandToken(token: string, vocabularies: Vocabulary[]): ExpandedToken {
  const variants = new Map<string, number>([[token, 1]]);
  if (/\d/.test(token)) return { token, variants, unknown: false }; // sizes and numbers: exact only

  const timesSeen = vocabularies.reduce((sum, v) => sum + (v.get(token) ?? 0), 0);
  // A word the stores use is trusted as typed. A word seen only once or twice
  // may itself be a store's typo, so a far more common spelling can still win.
  const limit = timesSeen > 2 ? 0 : typoLimit(token.length);
  const minPrefix = timesSeen > 0 ? 4 : 3;
  const typoCounts = new Map<string, { distance: number; count: number }>();

  for (const vocabulary of vocabularies) {
    for (const [word, count] of vocabulary) {
      if (word === token || /\d/.test(word)) continue;
      if (word === `${token}s` || token === `${word}s`) {
        variants.set(word, QUALITY_PLURAL);
      } else if (token.length >= minPrefix && word.startsWith(token)) {
        variants.set(word, QUALITY_PREFIX);
      } else if (limit > 0 && word[0] === token[0]) {
        const distance = typoDistance(token, word, limit);
        if (distance > limit) continue;
        const seen = typoCounts.get(word);
        if (seen) seen.count += count;
        else typoCounts.set(word, { distance, count });
      }
    }
  }

  // Keep only the closest spellings, and among those only the common ones.
  if (typoCounts.size > 0) {
    const closest = Math.min(...[...typoCounts.values()].map((c) => c.distance));
    const candidates = [...typoCounts].filter(([, c]) => c.distance === closest);
    const top = Math.max(...candidates.map(([, c]) => c.count));
    if (top >= timesSeen * 10) {
      for (const [word, c] of candidates) {
        if (c.count * 5 < top || variants.has(word)) continue;
        variants.set(word, closest === 1 ? QUALITY_ONE_TYPO : QUALITY_TWO_TYPOS);
      }
    }
  }
  return { token, variants, unknown: timesSeen === 0 };
}

/**
 * How well each search word is found in each product of one index
 * (0 = not found). Only products that have at least one of the words appear.
 */
function wordQualities<T>(expanded: ExpandedToken[], index: Index<T>): Map<number, number[]> {
  const found = new Map<number, number[]>();
  const note = (position: number, word: number, quality: number) => {
    let qualities = found.get(position);
    if (!qualities) {
      qualities = new Array<number>(expanded.length).fill(0);
      found.set(position, qualities);
    }
    if (quality > qualities[word]!) qualities[word] = quality;
  };
  expanded.forEach(({ variants }, word) => {
    for (const [variant, quality] of variants) {
      for (const position of index.postings.get(variant) ?? []) note(position, word, quality);
    }
  });
  // "make up" in the search, "makeup" in the product name.
  for (let word = 0; word + 1 < expanded.length; word++) {
    const joined = expanded[word]!.token + expanded[word + 1]!.token;
    for (const position of index.postings.get(joined) ?? []) {
      note(position, word, 1);
      note(position, word + 1, 1);
    }
  }
  return found;
}

/** A matched product: which index it is in, and where. */
type Hit = { index: number; position: number; score: number };

/**
 * The search as the matched products spell it: each misspelled or half-typed
 * word becomes the product word it matched most often ("garnir" -> "garnier",
 * "effac" -> "effaclar"). Null when every word was already spelled that way.
 */
function spellingUsed<T>(
  expanded: ExpandedToken[],
  indexes: Index<T>[],
  hits: Hit[],
): string | null {
  const matched = indexes.map(() => new Set<number>());
  for (const hit of hits) matched[hit.index]!.add(hit.position);
  /** How many matched products have this word. */
  const uses = (word: string) =>
    indexes.reduce(
      (n, index, i) =>
        n + (index.postings.get(word) ?? []).filter((p) => matched[i]!.has(p)).length,
      0,
    );

  let changed = false;
  const words = expanded.map(({ token, variants, unknown }) => {
    if (!unknown || variants.size === 1 || uses(token) > 0) return token;
    let best = token;
    let bestCount = 0;
    for (const variant of variants.keys()) {
      if (variant === token) continue;
      const count = uses(variant);
      if (count > bestCount) {
        best = variant;
        bestCount = count;
      }
    }
    if (best !== token) changed = true;
    return best;
  });
  return changed ? words.join(" ") : null;
}

export type MatchResult<T> = {
  /** The most suitable products, in no particular order. */
  matches: T[];
  /** True when no product has every search word, so these are only the closest. */
  approximate: boolean;
  /** The search as understood after fixing spelling, or null if unchanged. */
  corrected: string | null;
};

/**
 * Pick the products that best fit the search, from one or more indexes.
 *  - Products containing every search word (allowing typos and partial words) win.
 *  - If there are none, the products containing the most search words are
 *    returned instead (at least half of the words), flagged as approximate.
 */
export function findBestMatches<T>(query: string, indexes: Index<T>[]): MatchResult<T> {
  const vocabularies = indexes.map((index) => index.vocabulary);
  const expanded = tokens(query).map((t) => expandToken(t, vocabularies));
  const total = expanded.length;
  if (total === 0) return { matches: [], approximate: false, corrected: null };

  const minimumFound = Math.max(1, Math.ceil(total / 2));
  let bestFound = total > 1 ? minimumFound : 1;
  let bestScore = 0;
  let candidates: Hit[] = [];

  indexes.forEach((index, indexNumber) => {
    for (const [position, qualities] of wordQualities(expanded, index)) {
      let found = 0;
      let score = 0;
      let foundRealWord = false;
      qualities.forEach((quality, i) => {
        if (quality === 0) return;
        found++;
        score += quality;
        if (!/^\d/.test(expanded[i]!.token)) foundRealWord = true;
      });
      // A product must share an actual word with the search, not just a size.
      if (found < bestFound || (!foundRealWord && found < total)) continue;
      if (found > bestFound) {
        bestFound = found;
        bestScore = 0;
        candidates = [];
      }
      score /= total;
      if (score > bestScore) bestScore = score;
      candidates.push({ index: indexNumber, position, score });
    }
  });

  const kept = candidates.filter((c) => c.score >= bestScore - SCORE_BAND);
  return {
    matches: kept.map((hit) => indexes[hit.index]!.items[hit.position]!),
    approximate: kept.length > 0 && bestFound < total,
    corrected: spellingUsed(expanded, indexes, kept),
  };
}
