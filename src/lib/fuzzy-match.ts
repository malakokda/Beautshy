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
const IGNORED_WORDS = new Set(["and", "with", "for", "of", "the", "in", "و", "مع"]);

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
    .replace(/مل/g, "ml")
    .replace(/جم|جرام/g, "g")
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
export type Vocabulary = Map<string, number>;

/** A product (or anything else) together with the words of its name. */
export type Entry<T> = { item: T; words: Set<string> };

/**
 * The words of a product name, plus every pair of neighbouring words joined,
 * so "Sebio-Control" also answers to "sebiocontrol" and "make up" to "makeup".
 * When a vocabulary is given, the single words are counted into it.
 */
export function wordSet(text: string, vocabulary?: Vocabulary): Set<string> {
  const words = tokens(text);
  const set = new Set(words);
  if (vocabulary) {
    for (const word of set) vocabulary.set(word, (vocabulary.get(word) ?? 0) + 1);
  }
  for (let i = 0; i + 1 < words.length; i++) set.add(words[i]! + words[i + 1]!);
  return set;
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

/** How well each search word is found in one product (0 = not found). */
function wordQualities(expanded: ExpandedToken[], words: Set<string>): number[] {
  const qualities = expanded.map(({ variants }) => {
    let best = 0;
    if (variants.size <= words.size) {
      for (const [variant, quality] of variants) {
        if (quality > best && words.has(variant)) best = quality;
      }
    } else {
      for (const word of words) {
        const quality = variants.get(word);
        if (quality !== undefined && quality > best) best = quality;
      }
    }
    return best;
  });
  // "make up" in the search, "makeup" in the product name.
  for (let i = 0; i + 1 < expanded.length; i++) {
    if (qualities[i] === 1 && qualities[i + 1] === 1) continue;
    if (words.has(expanded[i]!.token + expanded[i + 1]!.token)) {
      qualities[i] = 1;
      qualities[i + 1] = 1;
    }
  }
  return qualities;
}

/**
 * The search as the matched products spell it: each misspelled or half-typed
 * word becomes the product word it matched most often ("garnir" -> "garnier",
 * "effac" -> "effaclar"). Null when every word was already spelled that way.
 */
function spellingUsed(expanded: ExpandedToken[], matched: Set<string>[]): string | null {
  let changed = false;
  const words = expanded.map(({ token, variants, unknown }) => {
    if (!unknown || variants.size === 1 || matched.some((words) => words.has(token))) return token;
    let best = token;
    let bestCount = 0;
    for (const variant of variants.keys()) {
      if (variant === token) continue;
      const count = matched.reduce((n, words) => n + (words.has(variant) ? 1 : 0), 0);
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
 * Pick the products that best fit the search.
 *  - Products containing every search word (allowing typos and partial words) win.
 *  - If there are none, the products containing the most search words are
 *    returned instead (at least half of the words), flagged as approximate.
 */
export function findBestMatches<T>(
  query: string,
  entries: Entry<T>[],
  vocabularies: Vocabulary[],
): MatchResult<T> {
  const expanded = tokens(query).map((t) => expandToken(t, vocabularies));
  const total = expanded.length;
  if (total === 0) return { matches: [], approximate: false, corrected: null };

  const minimumFound = Math.max(1, Math.ceil(total / 2));
  let bestFound = total > 1 ? minimumFound : 1;
  let bestScore = 0;
  let candidates: { entry: Entry<T>; score: number }[] = [];

  for (const entry of entries) {
    const qualities = wordQualities(expanded, entry.words);
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
    candidates.push({ entry, score });
  }

  const kept = candidates.filter((c) => c.score >= bestScore - SCORE_BAND).map((c) => c.entry);
  return {
    matches: kept.map((entry) => entry.item),
    approximate: kept.length > 0 && bestFound < total,
    corrected: spellingUsed(
      expanded,
      kept.map((entry) => entry.words),
    ),
  };
}
