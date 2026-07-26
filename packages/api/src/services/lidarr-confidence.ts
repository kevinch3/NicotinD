/**
 * "Is this Lidarr hit trustworthy enough to act on?" — the single home for that
 * policy (issue #212 direction 2).
 *
 * ## Why name-only
 *
 * The obvious corroboration signal is "the candidate actually has albums", and the
 * original sketch for this guard used `albumCount > 0`. Measured against prod:
 * **`/api/v1/artist/lookup` does not populate `albumCount` or `statistics` at all**
 * (they only appear on `/artist`, the monitored-library endpoint). A guard built on
 * it silently degenerates to bare string equality, which is exactly what re-breaks
 * the #211/#217 canonical-name-drift widening. So corroboration here is purely
 * lexical, and is calibrated against real prod pairs (see the test file).
 *
 * ## What this is for
 *
 * This is a **junk filter, not a match validator**. On names alone it cannot decide
 * whether `teacha tom` → `Teacha` is the same act. What it *can* do reliably is
 * reject the failure this guard exists for: a delimiter-less mash
 * (`2 MinutosTruenoDie Toten Hosen`) fuzzy-matching the garbage artist `"2"`. That
 * hit explains ~3% of the query string, while every legitimate drift observed in
 * prod explains ≥37% — coverage separates the two cleanly. Keep the bar there:
 * blocking a real artist costs a user their discography page, so when in doubt this
 * returns `true`.
 */

/** Non-alphanumerics, after accents are stripped. */
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;
const COMBINING = /[̀-ͯ]/g;

/**
 * Fold a name to a comparison key: accent-stripped, lowercased, and with **all**
 * separators removed — so `Tru La La` and `Trulalá` collapse to the same key. This
 * mirrors Lidarr's own `cleanName` field, which is why spacing variants come out as
 * exact matches for free.
 */
export function cleanArtistKey(s: string): string {
  return s.normalize('NFD').replace(COMBINING, '').toLowerCase().replace(NON_ALNUM, '');
}

/**
 * Levenshtein distance, abandoned as soon as it provably exceeds `k`.
 *
 * Ukkonen banding: only cells within `k` of the diagonal can contribute to a final
 * distance ≤ k, so each row is computed over a window of width `2k+1` rather than
 * the full string. That makes this **O(n·k)** rather than O(n·m), and the
 * length-delta pre-check rejects the common mismatch case in O(1). Two rolling rows
 * keep allocation at 2·(n+1) numbers with no matrix.
 *
 * Returns the distance, or `null` when it exceeds `k` (the caller only ever needs
 * "close enough or not", so an exact value past the cutoff is wasted work).
 */
export function boundedEditDistance(a: string, b: string, k: number): number | null {
  if (a === b) return 0;
  // Normalize orientation so `a` is never the longer string (band math assumes it).
  if (a.length > b.length) [a, b] = [b, a];
  const n = a.length;
  const m = b.length;
  if (m - n > k) return null; // length delta alone exceeds the budget
  if (n === 0) return m <= k ? m : null;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let i = 0; i <= n; i++) prev[i] = i;

  for (let j = 1; j <= m; j++) {
    // Only columns within the band can yield a distance ≤ k.
    const lo = Math.max(1, j - k);
    const hi = Math.min(n, j + k);
    curr[lo - 1] = lo - 1 === 0 ? j : Infinity;
    let rowMin = curr[lo - 1]!;

    for (let i = lo; i <= hi; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[i] ?? Infinity) + 1;
      const ins = (curr[i - 1] ?? Infinity) + 1;
      const sub = (prev[i - 1] ?? Infinity) + cost;
      const v = Math.min(del, ins, sub);
      curr[i] = v;
      if (v < rowMin) rowMin = v;
    }
    for (let i = hi + 1; i <= n; i++) curr[i] = Infinity;

    if (rowMin > k) return null; // whole row is out of budget — cannot recover
    [prev, curr] = [curr, prev];
  }

  const d = prev[n]!;
  return d <= k ? d : null;
}

/**
 * Minimum share of the longer key the shorter one must explain. `"2"` against
 * `"2minutostruenodietotenhosen"` scores 0.034; the weakest legitimate prod drift
 * (`NPR Music` → `NPR`) scores 0.375. 0.34 sits in that gap with margin on both
 * sides.
 */
const MIN_COVERAGE = 0.34;

/**
 * Below this length a one-character edit is not evidence of anything — `ME` vs
 * `Âme` (a documented false pair) and `Telzen` vs `Tenzen` (different artists) are
 * both distance 1. Short names must match exactly or via containment.
 */
const MIN_FUZZY_LENGTH = 8;

/** Similarity floor for the fuzzy path, as `1 - distance/maxLength`. */
const MIN_SIMILARITY = 0.85;

/** The subset of a Lidarr artist this policy reads. */
export interface LidarrHitLike {
  artistName: string;
}

/**
 * Accent/case fold that **keeps** punctuation. Only used for names whose clean key
 * is empty — `"!!!"` is a real artist (prod has it) and folds to `''`, which would
 * otherwise be rejected against itself.
 */
function foldLoose(s: string): string {
  return s.normalize('NFD').replace(COMBINING, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * True when `hit` is a trustworthy resolution of the library name `query`.
 *
 * Checks run cheapest-first and short-circuit, so the expensive edit-distance path
 * is reached only by names that are already close in length and share no
 * containment relationship:
 *
 * 1. exact key match — O(n)
 * 2. coverage floor — O(1), rejects junk like `"2"`
 * 3. containment either direction — O(n·m) worst case via native `includes`
 * 4. banded edit distance — O(n·k), gated behind a length floor
 */
export function corroboratesLidarrHit(query: string, hit: LidarrHitLike): boolean {
  const q = cleanArtistKey(query);
  // Both sides MUST go through the same normalizer. Lidarr's own `cleanName` looks
  // tempting but is normalized under different rules — it strips English stopwords
  // ("Bob Marley & The Wailers" → "bobmarleywailers", "Agents of Time" →
  // "agentstime"), so comparing our key against theirs rejects identical names.
  const h = cleanArtistKey(hit.artistName);

  // Punctuation-only names ("!!!") clean to an empty key — compare them loosely
  // rather than rejecting them against themselves.
  if (!q || !h) return foldLoose(query) === foldLoose(hit.artistName) && query.trim() !== '';


  if (q === h) return true;

  const longer = Math.max(q.length, h.length);
  const shorter = Math.min(q.length, h.length);
  if (shorter / longer < MIN_COVERAGE) return false;

  // Canonical-name drift is overwhelmingly a containment relationship: the library
  // name is a slice of the canonical one ("Eduardo Miño" ⊂ "Luis Eduardo Miño
  // Naranjo") or vice versa ("Zamy Juárez Abad" ⊃ "Zamy Juárez").
  if (longer >= MIN_FUZZY_LENGTH && (h.includes(q) || q.includes(h))) return true;

  // Spelling variants ("Riki" / "Ricky"). Budget derives from the similarity floor,
  // so `k` stays tiny (1–7 for real names) and the banded DP is effectively linear.
  if (longer < MIN_FUZZY_LENGTH) return false;
  const k = Math.floor((1 - MIN_SIMILARITY) * longer);
  if (k < 1) return false;
  return boundedEditDistance(q, h, k) !== null;
}
