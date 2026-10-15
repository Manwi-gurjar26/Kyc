/**
 * Name normalisation and fuzzy matching for Indian names.
 *
 * This is the function that decides how much manual review work the compliance
 * team gets. It is called whenever two names have to agree:
 *   - the Aadhaar name vs what the PAN service says matched
 *   - the Aadhaar name vs the name the bank holds on the account
 *   - the Aadhaar name vs the owner named on a land record
 *   - the GST legal name vs the MCA company name
 *
 * The score never decides anything on its own. core.decideKyc() compares it
 * with a threshold held in the settings table, so Ops can retune without a
 * release.
 */

/** Titles that carry no identity. Matched as whole tokens only. */
const HONORIFICS = new Set([
  "SHRI",
  "SHREE",
  "SH",
  "SMT",
  "SRIMATI",
  "MR",
  "MRS",
  "MS",
  "MISS",
  "DR",
  "PROF",
  "KUMARI",
  "KUM",
  "LATE",
  "M/S",
  "MESSRS",
]);

/**
 * Relationship markers that appear on land records and older documents.
 * The name that follows is a parent or spouse, not the subject — but we keep
 * it, because reviewers compare father's names too.
 */
const RELATION_MARKERS = new Set(["S/O", "D/O", "W/O", "C/O", "SON", "DAUGHTER", "WIFE"]);

/** A single-letter token is an initial, e.g. the "R" in "R K Sharma". */
function isInitial(token: string): boolean {
  return token.length === 1;
}

/**
 * Uppercases, removes punctuation, drops honorifics and relationship markers,
 * and collapses whitespace.
 *
 * Honorifics are removed as whole tokens, so "Drishti" survives even though it
 * starts with "Dr".
 */
export function normaliseName(value: string): string {
  const cleaned = value
    .toUpperCase()
    // Keep the slash so S/O and W/O survive to be matched as tokens.
    .replace(/[.,_]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned
    .split(" ")
    .filter((token) => token.length > 0)
    .filter((token) => !HONORIFICS.has(token))
    .filter((token) => !RELATION_MARKERS.has(token))
    // Drop anything that is not letters once the markers are gone.
    .map((token) => token.replace(/[^A-Z]/g, ""))
    .filter((token) => token.length > 0);

  return tokens.join(" ");
}

/**
 * Jaro similarity: the proportion of matching characters, adjusted for how
 * many of them are transposed.
 */
function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  const half = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - half) / matches) / 3;
}

/**
 * Jaro-Winkler: Jaro, with a bonus for a shared prefix. Suits names, where
 * people get the beginning right and the ending wrong (Gupta / Guptha).
 */
function jaroWinkler(a: string, b: string): number {
  const base = jaro(a, b);
  if (base < 0.7) return base;

  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;

  return base + prefix * 0.1 * (1 - base);
}

/** How much credit an initial gets for standing in for a full name. */
const INITIAL_MATCH_SCORE = 0.9;

/** Penalty per token present in one name but absent from the other. */
const MISSING_TOKEN_PENALTY = 0.15;

/**
 * Below this, two tokens are not a spelling variant of each other — they are
 * different words, and they earn no credit.
 *
 * Without a floor, Jaro-Winkler rewards unrelated Indian names for sharing
 * common letters: SHARMA against DESAI scores around 0.55 purely on shared
 * vowels, which was enough to lift two different people into the review band
 * instead of leaving them rejected.
 */
const TOKEN_FLOOR = 0.7;

/** Similarity of two single tokens, handling initials. */
function tokenScore(a: string, b: string): number {
  if (a === b) return 1;
  if (isInitial(a) || isInitial(b)) {
    const initial = isInitial(a) ? a : b;
    const full = isInitial(a) ? b : a;
    return full.startsWith(initial) ? INITIAL_MATCH_SCORE : 0;
  }
  const score = jaroWinkler(a, b);
  return score < TOKEN_FLOOR ? 0 : score;
}

/**
 * Returns 0..1 for how well two names agree, ignoring word order.
 *
 * Every token of the shorter name is greedily paired with its best unused
 * partner in the longer name, then a flat penalty is applied for each token
 * the shorter name was missing. That ordering is deliberate: dropping a middle
 * name is common and forgiven, while having only a first name in common is not.
 */
export function nameMatchScore(left: string, right: string): number {
  const a = normaliseName(left).split(" ").filter(Boolean);
  const b = normaliseName(right).split(" ").filter(Boolean);

  if (a.length === 0 || b.length === 0) return 0;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Array<boolean>(longer.length).fill(false);

  let total = 0;
  for (const token of shorter) {
    let bestScore = 0;
    let bestIndex = -1;
    for (let i = 0; i < longer.length; i += 1) {
      if (used[i]) continue;
      const score = tokenScore(token, longer[i]!);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) used[bestIndex] = true;
    total += bestScore;
  }

  const base = total / shorter.length;
  const penalty = MISSING_TOKEN_PENALTY * (longer.length - shorter.length);

  return Math.min(1, Math.max(0, base - penalty));
}
