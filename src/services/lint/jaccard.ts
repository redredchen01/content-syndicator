/**
 * 5-gram character-shingle Jaccard similarity (Plan Unit 7).
 *
 * Used as the load-bearing batch-level dedup gate (R23). Per-variant
 * pairwise similarity ≥ brand_profile.jaccard_threshold blocks the
 * batch and forces the editor to regenerate the weaker variant.
 *
 * Why character 5-grams (not word tokens)?
 * - Robust to Chinese / English / mixed text without a tokenizer.
 * - Captures phrasing reuse at sub-word granularity.
 * - Matches what the document-review adversarial agent recommended
 *   when shingle-overlap was suggested as the more Google-realistic
 *   alternative to embedding cosine.
 */

const GRAM_SIZE = 5;

/**
 * Normalizes text for shingling: strip markdown link syntax, code
 * fences, image syntax, HTML tags, then collapse whitespace and
 * lowercase. Returns the visible text approximation.
 */
export function normalizeForShingling(text: string): string {
  return text
    // Remove fenced code blocks (their content shouldn't drive similarity).
    .replace(/```[\s\S]*?```/g, ' ')
    // Inline code.
    .replace(/`[^`]*`/g, ' ')
    // Markdown image: ![alt](url) → keep alt only.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Markdown link: [anchor](url) → keep anchor only.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // HTML tags.
    .replace(/<[^>]+>/g, ' ')
    // Collapse whitespace.
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Returns the set of character 5-grams. Chinese characters count as
 * one character each, so 5-grams operate consistently across languages.
 */
export function tokenize5gram(text: string): Set<string> {
  const normalized = normalizeForShingling(text);
  const grams = new Set<string>();
  if (normalized.length < GRAM_SIZE) {
    grams.add(normalized);
    return grams;
  }
  // Use Array.from to handle multi-byte chars correctly.
  const chars = Array.from(normalized);
  for (let i = 0; i <= chars.length - GRAM_SIZE; i++) {
    grams.add(chars.slice(i, i + GRAM_SIZE).join(''));
  }
  return grams;
}

/** Standard Jaccard: |A ∩ B| / |A ∪ B|. Empty union returns 0. */
export function jaccardSim(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const item of a) if (b.has(item)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export interface PairwiseResult {
  /** Indices into the input array, [smaller, larger]. */
  pair: [number, number];
  similarity: number;
}

/**
 * Returns the pair with the highest Jaccard similarity across all
 * unordered combinations. Returns null when fewer than 2 inputs.
 */
export function pairwiseMaxJaccard(texts: string[]): PairwiseResult | null {
  if (texts.length < 2) return null;
  const grams = texts.map(tokenize5gram);
  let best: PairwiseResult = { pair: [0, 1], similarity: -1 };
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const sim = jaccardSim(grams[i], grams[j]);
      if (sim > best.similarity) {
        best = { pair: [i, j], similarity: sim };
      }
    }
  }
  return best;
}
