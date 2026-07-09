/**
 * Standardized library metadata filter — the one filter model shared by every
 * library list view (album grids, artists, artist songs) and by the API's
 * SQL fragment builder. Browser-safe: types + pure functions only.
 *
 * Serialization is a flat, human-readable query-param grammar
 * (`bpmMin=120&key=8A,9A&energy=low,high&genre=Rock&genre=Jazz`) so filters
 * live in shareable URLs. Parsing is deliberately lenient: malformed or
 * unknown values are dropped, never a 400 — hand-edited URLs degrade
 * gracefully.
 */

/** Perceptual 0–1 axes filterable via three fixed buckets. */
export const PERCEPTUAL_AXES = [
  'energy',
  'danceability',
  'valence',
  'acousticness',
  'instrumental',
] as const;
export type PerceptualAxis = (typeof PERCEPTUAL_AXES)[number];

export const PERCEPTUAL_BUCKETS = ['low', 'mid', 'high'] as const;
export type PerceptualBucket = (typeof PERCEPTUAL_BUCKETS)[number];

/** Fixed bucket boundaries: low ≤ 0.35 < mid < 0.65 ≤ high. */
export const BUCKET_THRESHOLDS = { low: 0.35, high: 0.65 } as const;

/** Canonical mood vocabulary written by the audio-features enrichment. */
export const MOOD_VOCAB = ['happy', 'sad', 'aggressive', 'relaxed', 'party'] as const;
export type MoodLabel = (typeof MOOD_VOCAB)[number];

export interface LibraryFilter {
  bpmMin?: number;
  bpmMax?: number;
  /** Camelot codes ('8A', '3B', …) — expanded to key spellings for matching. */
  keys?: string[];
  moods?: MoodLabel[];
  /** Per-axis bucket selection; buckets OR within an axis, axes AND. */
  buckets?: Partial<Record<PerceptualAxis, PerceptualBucket[]>>;
  yearMin?: number;
  yearMax?: number;
  genres?: string[];
  /** Entity-level starred (album/artist/song starred, not any-track). */
  starred?: boolean;
  /** Track duration bounds in seconds. */
  durationMin?: number;
  durationMax?: number;
}

// ── Camelot wheel ──────────────────────────────────────────────────────────
// Same pitch-class → code mapping as key-detection.ts (a test there asserts
// the two can't drift). Sharp spelling is the pipeline-canonical DB form;
// the flat enharmonic covers tag-sourced spellings.

const SHARP_TONICS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_OF: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' };
const MAJOR_CAMELOT = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR_CAMELOT = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

export interface CamelotEntry {
  /** Camelot code, e.g. '8B'. A = minor ring, B = major ring. */
  code: string;
  /** Canonical (sharp-spelled) key, e.g. 'C# major'. */
  key: string;
  /** Flat enharmonic spelling when one exists, e.g. 'Db major'. */
  enharmonic?: string;
}

function buildWheel(): CamelotEntry[] {
  const entries: CamelotEntry[] = [];
  for (const [mode, codes] of [
    ['minor', MINOR_CAMELOT],
    ['major', MAJOR_CAMELOT],
  ] as const) {
    for (let pc = 0; pc < 12; pc++) {
      const tonic = SHARP_TONICS[pc]!;
      const flat = FLAT_OF[tonic];
      entries.push({
        code: codes[pc]!,
        key: `${tonic} ${mode}`,
        ...(flat ? { enharmonic: `${flat} ${mode}` } : {}),
      });
    }
  }
  // Order by ring (A then B) and wheel position for pickers.
  return entries.sort((a, b) =>
    a.code.slice(-1) === b.code.slice(-1)
      ? parseInt(a.code, 10) - parseInt(b.code, 10)
      : a.code.slice(-1) < b.code.slice(-1)
        ? -1
        : 1,
  );
}

export const CAMELOT_WHEEL: ReadonlyArray<CamelotEntry> = buildWheel();

const WHEEL_BY_CODE = new Map(CAMELOT_WHEEL.map((e) => [e.code, e]));

/** Key spellings matching a Camelot code (sharp + flat), [] for unknown codes. */
export function camelotToKeys(code: string): string[] {
  const entry = WHEEL_BY_CODE.get(code.toUpperCase());
  if (!entry) return [];
  return entry.enharmonic ? [entry.key, entry.enharmonic] : [entry.key];
}

// ── Serialization ──────────────────────────────────────────────────────────

/**
 * Flat query params. `genre` is a repeated param (free text may contain
 * commas); every closed-vocabulary list is comma-joined.
 */
export function serializeLibraryFilter(f: LibraryFilter): Record<string, string | string[]> {
  const q: Record<string, string | string[]> = {};
  if (f.bpmMin !== undefined) q.bpmMin = String(f.bpmMin);
  if (f.bpmMax !== undefined) q.bpmMax = String(f.bpmMax);
  if (f.keys?.length) q.key = f.keys.join(',');
  if (f.moods?.length) q.mood = f.moods.join(',');
  for (const axis of PERCEPTUAL_AXES) {
    const buckets = f.buckets?.[axis];
    if (buckets?.length) q[axis] = buckets.join(',');
  }
  if (f.yearMin !== undefined) q.yearMin = String(f.yearMin);
  if (f.yearMax !== undefined) q.yearMax = String(f.yearMax);
  if (f.genres?.length) q.genre = [...f.genres];
  if (f.starred) q.starred = 'true';
  if (f.durationMin !== undefined) q.durMin = String(f.durationMin);
  if (f.durationMax !== undefined) q.durMax = String(f.durationMax);
  return q;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function num(v: string | string[] | undefined): number | undefined {
  const s = first(v);
  if (s === undefined || s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function list(v: string | string[] | undefined): string[] {
  const s = first(v);
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Lenient inverse of serializeLibraryFilter — unknown/malformed values are dropped. */
export function parseLibraryFilter(
  query: Record<string, string | string[] | undefined>,
): LibraryFilter {
  const f: LibraryFilter = {};
  const bpmMin = num(query.bpmMin);
  const bpmMax = num(query.bpmMax);
  if (bpmMin !== undefined) f.bpmMin = bpmMin;
  if (bpmMax !== undefined) f.bpmMax = bpmMax;

  const keys = list(query.key)
    .map((k) => k.toUpperCase())
    .filter((k) => WHEEL_BY_CODE.has(k));
  if (keys.length) f.keys = [...new Set(keys)];

  const moods = list(query.mood).filter((m): m is MoodLabel =>
    (MOOD_VOCAB as readonly string[]).includes(m),
  );
  if (moods.length) f.moods = [...new Set(moods)];

  for (const axis of PERCEPTUAL_AXES) {
    const buckets = list(query[axis]).filter((b): b is PerceptualBucket =>
      (PERCEPTUAL_BUCKETS as readonly string[]).includes(b),
    );
    if (buckets.length) {
      f.buckets ??= {};
      f.buckets[axis] = [...new Set(buckets)];
    }
  }

  const yearMin = num(query.yearMin);
  const yearMax = num(query.yearMax);
  if (yearMin !== undefined) f.yearMin = yearMin;
  if (yearMax !== undefined) f.yearMax = yearMax;

  const genreRaw = query.genre;
  const genres = (Array.isArray(genreRaw) ? genreRaw : genreRaw !== undefined ? [genreRaw] : [])
    .map((g) => g.trim())
    .filter(Boolean);
  if (genres.length) f.genres = [...new Set(genres)];

  if (first(query.starred) === 'true') f.starred = true;

  const durMin = num(query.durMin);
  const durMax = num(query.durMax);
  if (durMin !== undefined) f.durationMin = durMin;
  if (durMax !== undefined) f.durationMax = durMax;
  return f;
}

// ── State helpers ──────────────────────────────────────────────────────────

/** One count per active property group; each perceptual axis counts separately. */
export function activeLibraryFilterCount(f: LibraryFilter): number {
  let n = 0;
  if (f.bpmMin !== undefined || f.bpmMax !== undefined) n++;
  if (f.keys?.length) n++;
  if (f.moods?.length) n++;
  for (const axis of PERCEPTUAL_AXES) if (f.buckets?.[axis]?.length) n++;
  if (f.yearMin !== undefined || f.yearMax !== undefined) n++;
  if (f.genres?.length) n++;
  if (f.starred) n++;
  if (f.durationMin !== undefined || f.durationMax !== undefined) n++;
  return n;
}

export function isEmptyLibraryFilter(f: LibraryFilter): boolean {
  return activeLibraryFilterCount(f) === 0;
}
