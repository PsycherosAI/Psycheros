/**
 * Title normalization and near-duplicate detection for vault documents.
 *
 * Why this exists: in April 2026 an entity "updated" the same vault document
 * five times by calling write with a slightly different title each time
 * ("... (started 4/3/2026)" → "... (updated 4/5)" → ...). The exact-title
 * duplicate guard never fired because the titles were never exactly equal,
 * and the document forked into orphaned copies that were lost piecemeal.
 * These helpers let the vault tool catch that pattern.
 *
 * The key mechanism is stripping TRAILING version-noise tokens (dates,
 * "updated", "final", "part 2", ...) during normalization: that is where
 * title churn lives. A trailing run only, so meaningful mid-title words
 * survive and "My Document - Part One" vs "- Part Two" still count as
 * distinct documents.
 */

/** Words that, at the END of a title, carry no identity. */
const NOISE_WORDS = new Set([
  "as",
  "complete",
  "compiled",
  "created",
  "create",
  "draft",
  "final",
  "of",
  "on",
  "part",
  "revised",
  "revision",
  "saved",
  "save",
  "session",
  "start",
  "started",
  "update",
  "updated",
  "ver",
  "version",
  "written",
]);

/**
 * Normalize a title for comparison: lowercase, strip diacritics, collapse
 * every non-alphanumeric run (spaces, punctuation, parens, dates) to a
 * single space, trim, then drop the trailing run of version-noise tokens
 * (numeric dates like "4 3 2026" and words like "updated" / "final").
 */
export function normalizeTitle(title: string): string {
  const collapsed = title
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = collapsed.split(" ").filter((t) => t.length > 0);
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    if (/^\d+$/.test(last) || NOISE_WORDS.has(last)) {
      tokens.pop();
    } else {
      break;
    }
  }
  return tokens.join(" ");
}

/** Minimum normalized length for the containment rule to apply. */
const CONTAINMENT_MIN_LENGTH = 12;
/** Shorter/longer length ratio below which containment is treated as noise. */
const CONTAINMENT_MIN_RATIO = 0.5;

/**
 * True when two titles refer to the same document closely enough that a
 * `write` with the new title would fork an existing document. Exact
 * normalized equality always matches; otherwise one title must contain the
 * other, with the contained title long enough and close enough in length
 * that the match is meaningful rather than a generic short title ("AU",
 * "notes") matching everything.
 */
export function isNearDuplicateTitle(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na === nb) return true;

  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (long.includes(short)) {
    return short.length >= CONTAINMENT_MIN_LENGTH &&
      short.length / long.length >= CONTAINMENT_MIN_RATIO;
  }
  return false;
}

/**
 * Find the first title in `candidates` that is a near-duplicate of `title`.
 * Exact normalized matches win over containment matches; within each tier
 * the longest candidate wins (most specific). Returns null when nothing is
 * close.
 */
export function findNearDuplicateTitle(
  title: string,
  candidates: string[],
): string | null {
  const exact: string[] = [];
  const fuzzy: string[] = [];
  for (const candidate of candidates) {
    if (normalizeTitle(title) === normalizeTitle(candidate)) {
      exact.push(candidate);
    } else if (isNearDuplicateTitle(title, candidate)) {
      fuzzy.push(candidate);
    }
  }
  const longest = (list: string[]) =>
    list.reduce<string | null>(
      (best, c) => (best === null || c.length > best.length ? c : best),
      null,
    );
  return longest(exact) ?? longest(fuzzy);
}
