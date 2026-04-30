/**
 * Pre-publish identity-exposure regex lint (Plan Unit 7, R23).
 *
 * Compiles brand_profile.exposure_blocklist into RegExp objects and
 * scans rendered variant bodies. First match returned to the UI for
 * the editor to fix or skip the variant.
 *
 * The blocklist is plain strings (escape-safe) so editors don't need
 * to know regex syntax. Internally we wrap with word boundaries where
 * the locale supports them, and use plain substring match for CJK.
 */

/** Returns true when the string contains any CJK ideograph. */
function hasCjk(s: string): boolean {
  return /[一-鿿]/.test(s);
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a single blocklist entry into a RegExp. Latin-only entries
 * get word boundaries; CJK entries use plain substring (since `\b`
 * doesn't bracket ideographs in JavaScript).
 */
export function compileRule(entry: string): RegExp {
  const escaped = escapeForRegex(entry.trim());
  if (escaped.length === 0) {
    throw new Error('Empty exposure blocklist entry');
  }
  if (hasCjk(entry)) return new RegExp(escaped, 'gi');
  return new RegExp(`\\b${escaped}\\b`, 'gi');
}

export function compileBlocklist(entries: string[]): RegExp[] {
  return entries.filter((e) => e.trim().length > 0).map(compileRule);
}

export interface ExposureMatch {
  /** The blocklist entry that matched (raw string, not the regex). */
  rule: string;
  /** Start index in the input text. */
  index: number;
  /** Surrounding excerpt for UI display (≈40 chars window). */
  excerpt: string;
}

/**
 * Scans `text` for any exposure blocklist hit. Returns the FIRST
 * match (left-to-right) so the editor can fix one and re-run. Pass
 * the same blocklist + entries — both arrays must align by index.
 */
export function findFirstExposure(
  text: string,
  blocklist: string[],
  rules: RegExp[],
): ExposureMatch | null {
  if (blocklist.length !== rules.length) {
    throw new Error('blocklist and rules arrays must have equal length');
  }
  let earliest: ExposureMatch | null = null;
  for (let i = 0; i < rules.length; i++) {
    const rx = rules[i];
    rx.lastIndex = 0;
    const m = rx.exec(text);
    if (m && (earliest === null || m.index < earliest.index)) {
      earliest = {
        rule: blocklist[i],
        index: m.index,
        excerpt: extractExcerpt(text, m.index, m[0].length),
      };
    }
  }
  return earliest;
}

function extractExcerpt(text: string, index: number, matchLen: number): string {
  const PAD = 20;
  const start = Math.max(0, index - PAD);
  const end = Math.min(text.length, index + matchLen + PAD);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}
