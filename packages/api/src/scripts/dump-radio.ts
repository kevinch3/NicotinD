/**
 * Radio diagnostic dump (read-only, developer tool) — generate a radio the
 * exact way `GET /api/radio/next` does, then write a human+Claude-readable
 * report of the seed, the candidate pool's genre-data health, and every output
 * track WITH its per-axis score breakdown.
 *
 *   # seed radio from a song
 *   bun run packages/api/src/scripts/dump-radio.ts --seed <songId>
 *   # seed radio from an artist's catalogue (convenience)
 *   bun run packages/api/src/scripts/dump-radio.ts --artist "José Larralde"
 *   # filter ("vibe") radio — same flags parseLibraryFilter accepts
 *   bun run packages/api/src/scripts/dump-radio.ts --genre Folk --bpm-min 90 --bpm-max 120
 *
 * Flags: --count N (default 12), --out <path> (default <dataDir>/radio-dump-<ts>.md),
 *        --json (emit JSON alongside the markdown path), filter flags:
 *        --genre <g> (repeatable), --bpm-min/--bpm-max, --year-min/--year-max,
 *        --key <code>, --mood <m>, --dur-min/--dur-max, --starred,
 *        --weights genre=14,embedding=8 (A/B a candidate DEFAULT_WEIGHTS change).
 *
 * WHY this exists: seed radios are genre-coherent but filter ("vibe") radios pull
 * cross-genre tracks (José Larralde Folk → Katy Perry Pop). The per-axis breakdown
 * tells the two root causes apart: a genre axis SCORED 0 = disjoint tags lost on
 * weight (raise the genre weight / add a co-constraint); a genre axis FLOORED =
 * the track has no genre data at all (a detection/backfill gap). No DB writes.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG. See docs/radio.md "Diagnostic dump".
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { parseLibraryFilter, type LibraryFilter } from '@nicotind/core';
import { expandHome } from '@nicotind/core';
import {
  explainSimilarity,
  genreSetCloseness,
  MISSING_GENRE_FLOOR,
  parseWeightOverrides,
  type ScoringWeights,
  type SimilarityExplanation,
  type SongFeatures,
} from '../services/radio.service.js';
import { isRealGenre } from '../services/genre-split.js';
import { artistGenreShares } from '../services/genre-distribution.js';
import { DEPTH_CREDIT, matchedGenrePosition } from '../services/station-affinity.js';
import {
  RADIO_SONG_SELECT,
  buildSeedRadio,
  buildFilterRadio,
  genresOf,
  type RadioSongRow,
  type RadioCandidate,
  type RadioResult,
} from '../routes/radio.js';

function loadConfig(): { dataDir: string } {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  const dataDir = expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
  return { dataDir };
}

/** Minimal `--flag value` / `--flag` parser (repeats collected into arrays). */
function parseArgs(argv: string[]): Record<string, string[] | true> {
  const out: Record<string, string[] | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      const cur = out[key];
      out[key] = Array.isArray(cur) ? [...cur, next] : [next];
      i++;
    }
  }
  return out;
}

function firstArg(args: Record<string, string[] | true>, key: string): string | undefined {
  const v = args[key];
  return Array.isArray(v) ? v[0] : undefined;
}

/** CLI filter flags → the query shape parseLibraryFilter consumes (reuse the one parser). */
function filterFromArgs(args: Record<string, string[] | true>): LibraryFilter {
  const q: Record<string, string | string[] | undefined> = {};
  const genres = args['genre'];
  if (Array.isArray(genres)) q['genre'] = genres;
  const map: Record<string, string> = {
    'bpm-min': 'bpmMin',
    'bpm-max': 'bpmMax',
    'year-min': 'yearMin',
    'year-max': 'yearMax',
    'dur-min': 'durMin',
    'dur-max': 'durMax',
  };
  for (const [flag, qkey] of Object.entries(map)) {
    const v = firstArg(args, flag);
    if (v !== undefined) q[qkey] = v;
  }
  const keys = args['key'];
  if (Array.isArray(keys)) q['key'] = keys;
  const moods = args['mood'];
  if (Array.isArray(moods)) q['mood'] = moods;
  if (args['starred'] === true) q['starred'] = 'true';
  return parseLibraryFilter(q);
}

/** Lowercased alphanumeric genre tokens across a candidate's full genre set. */
function genreTokens(r: RadioSongRow): Set<string> {
  const tokens = new Set<string>();
  for (const g of genresOf(r) ?? []) {
    for (const t of g.toLowerCase().split(/[^a-z0-9]+/)) if (t) tokens.add(t);
  }
  return tokens;
}

function pct(n: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`;
}

/** One-line axis breakdown, e.g. "genre 0.00×10 · bpm 0.90×8 · key 1.00×6  [skipped: valence]". */
function breakdownLine(ex: SimilarityExplanation): string {
  const axes = ex.axes.map((a) => `${a.axis} ${a.value.toFixed(2)}×${a.weight}`).join(' · ');
  const skipped = ex.skipped.length ? `  [skipped: ${ex.skipped.join(', ')}]` : '';
  return axes + skipped;
}

/** How the genre axis fared for one candidate — the headline diagnostic. */
function genreVerdict(ex: SimilarityExplanation): string {
  // Stations spend the genre weight on graded membership instead (v3).
  const station = ex.axes.find((a) => a.axis === 'station');
  if (station) {
    if (station.value >= 0.75) return '✓ genre native';
    if (station.value >= 0.4) return `~ station ${station.value.toFixed(2)}`;
    return `✗ station ${station.value.toFixed(2)} (tagged, not native)`;
  }
  if (ex.skipped.includes('genre')) return '⚠ genre SKIPPED (seed has none)';
  if (ex.floored.includes('genre')) return '⚠ genre FLOORED (candidate has no data)';
  const g = ex.axes.find((a) => a.axis === 'genre');
  if (!g) return '';
  if (g.value === 0) return '✗ genre 0 (mismatch, lost on weight)';
  if (g.value >= 0.99) return '✓ genre match';
  return `~ genre ${g.value.toFixed(2)}`;
}

function seedLabel(row: RadioSongRow | null, seed: SongFeatures | null): string {
  if (row) return `${row.artist} — ${row.title}`;
  if (seed) return `centroid of the filtered pool`;
  return '(no seed)';
}

/**
 * Surface the recently-played demotion, so a queue that looks "wrong" can be
 * told apart from one that is correctly avoiding repeats. Invisible penalties
 * are unmeasurable, and this dump is how weights get justified before shipping.
 */
function recentVerdict(ex: { recentPlayPenaltyApplied: number }): string {
  return ex.recentPlayPenaltyApplied > 0
    ? `  [recently played −${ex.recentPlayPenaltyApplied.toFixed(3)}]`
    : '';
}

/** The genre set actually used for scoring (mirrors explainSimilarity's own
 *  `seed.genres ?? seed.genre` fallback) — a filter-radio centroid only ever
 *  carries the single modal `.genre`, never a `.genres` array (issue #187 B4). */
function effectiveGenres(seed: SongFeatures): string[] | undefined {
  if (seed.genres?.length) return seed.genres;
  return seed.genre ? [seed.genre] : undefined;
}

function renderSeedFeatures(row: RadioSongRow | null, seed: SongFeatures | null): string[] {
  const lines: string[] = [];
  if (seed === null) {
    lines.push('  (filter matched nothing / no centroid — empty result)');
    return lines;
  }
  const genres = row ? genresOf(row) : effectiveGenres(seed);
  lines.push(`  genre     : ${genres?.length ? genres.join(', ') : '(none)'}`);
  lines.push(`  bpm       : ${seed.bpm ?? '(none)'}`);
  lines.push(`  key       : ${seed.key ?? '(none)'}`);
  lines.push(`  year      : ${seed.year ?? '(none)'}`);
  lines.push(`  energy    : ${seed.energy?.toFixed(2) ?? '(none)'}`);
  lines.push(`  valence   : ${seed.valence?.toFixed(2) ?? '(none)'}`);
  return lines;
}

function renderPoolHealth(pool: RadioCandidate[], seedTokens: Set<string>): string[] {
  const total = pool.length;
  let noGenre = 0;
  let noBpm = 0;
  let noEnergy = 0;
  let sharesGenre = 0;
  let disjointGenre = 0;
  for (const c of pool) {
    const gs = genresOf(c._row) ?? [];
    if (gs.length === 0) noGenre++;
    else {
      const t = genreTokens(c._row);
      let shared = false;
      for (const tok of t) if (seedTokens.has(tok)) shared = true;
      if (shared) sharesGenre++;
      else disjointGenre++;
    }
    if (c.bpm === undefined) noBpm++;
    if (c.energy === undefined) noEnergy++;
  }
  return [
    `  pool size                    : ${total}`,
    `  missing genre (data gap)     : ${noGenre} (${pct(noGenre, total)})`,
    `  missing bpm                  : ${noBpm} (${pct(noBpm, total)})`,
    `  missing energy               : ${noEnergy} (${pct(noEnergy, total)})`,
    `  shares ≥1 genre token w/ seed: ${sharesGenre} (${pct(sharesGenre, total)})`,
    `  has genre but disjoint       : ${disjointGenre} (${pct(disjointGenre, total)})`,
  ];
}

/**
 * Station diagnostics — the measurement behind formula v3 (see docs/radio.md
 * "Stations"). A genre station's pool is selected BY the tag, so the question
 * a dump has to answer is not "did genre match" (it always did) but "how many
 * of these are actually of the genre".
 *
 * Prints, over the whole pool: what the plain genre axis WOULD have scored (the
 * constant-axis proof), the tag-depth histogram, the artist-catalogue-share
 * histogram, and embedding coverage. Recomputes depth/share rather than reading
 * them off the candidates because the point is to show the inputs, not the
 * blended output.
 */
function renderStationHealth(
  db: Database,
  filter: LibraryFilter,
  seed: SongFeatures,
  pool: RadioCandidate[],
): string[] {
  const stationGenres = (filter.genres ?? []).filter((g) => g && isRealGenre(g));
  if (stationGenres.length === 0) return [];
  const total = pool.length;

  let oldAxisPerfect = 0;
  const depths = new Map<string, number>([
    ['primary', 0],
    ['secondary', 0],
    ['deeper', 0],
    ['none', 0],
  ]);
  for (const c of pool) {
    const genres = genresOf(c._row);
    if ((genreSetCloseness(stationGenres, genres) ?? 0) >= 0.99) oldAxisPerfect++;
    const pos = matchedGenrePosition(genres, stationGenres);
    const bucket =
      pos === null ? 'none' : pos === 0 ? 'primary' : pos === 1 ? 'secondary' : 'deeper';
    depths.set(bucket, (depths.get(bucket) ?? 0) + 1);
  }

  const shares = artistGenreShares(
    db,
    pool.map((c) => c._row.artist_id),
    stationGenres,
  );
  const shareBuckets = [
    { label: 'under 10% (tagged, not of the genre)', lo: 0, hi: 0.1, n: 0 },
    { label: '10–30%', lo: 0.1, hi: 0.3, n: 0 },
    { label: '30–50%', lo: 0.3, hi: 0.5, n: 0 },
    { label: '50%+ (genre native)', lo: 0.5, hi: Infinity, n: 0 },
  ];
  for (const c of pool) {
    const share = shares.get(c._row.artist_id) ?? 0;
    const b = shareBuckets.find((x) => share >= x.lo && share < x.hi) ?? shareBuckets[3]!;
    b.n++;
  }

  const affinities = pool
    .map((c) => c.stationAffinity)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  const withEmbedding = pool.filter((c) => c.embedding).length;

  const lines = [
    `  station genres               : ${stationGenres.join(', ')}`,
    `  centroid modal primary genre : ${seed.genre ?? '(none)'}${
      seed.genre && !stationGenres.some((g) => g.toLowerCase() === seed.genre!.toLowerCase())
        ? '   ← NOT the requested genre'
        : ''
    }`,
    `  plain genre axis would score 1.00 for: ${oldAxisPerfect}/${total} (${pct(oldAxisPerfect, total)})`,
    `      ^ the constant-axis problem: that share of the pool is indistinguishable`,
    `        on the heaviest weight in the blend.`,
    `  tag depth:`,
    `    primary tag                : ${depths.get('primary')} (${pct(depths.get('primary')!, total)})  ×${DEPTH_CREDIT[0]}`,
    `    secondary tag              : ${depths.get('secondary')} (${pct(depths.get('secondary')!, total)})  ×${DEPTH_CREDIT[1]}`,
    `    third or deeper            : ${depths.get('deeper')} (${pct(depths.get('deeper')!, total)})  ×${DEPTH_CREDIT[2]}`,
    `    no matching tag            : ${depths.get('none')} (${pct(depths.get('none')!, total)})`,
    `  artist catalogue share in this genre:`,
    ...shareBuckets.map((b) => `    ${b.label.padEnd(29)}: ${b.n} (${pct(b.n, total)})`),
    `  station affinity (min/med/max): ${
      affinities.length
        ? `${affinities[0]!.toFixed(2)} / ${affinities[Math.floor(affinities.length / 2)]!.toFixed(2)} / ${affinities.at(-1)!.toFixed(2)}`
        : '(not graded)'
    }`,
    `  embedding coverage           : ${withEmbedding}/${total} (${pct(withEmbedding, total)})`,
    `  station anchor built         : ${seed.embedding ? 'yes' : 'no'}`,
  ];
  return lines;
}

function renderTrackBlock(
  seed: SongFeatures,
  cand: RadioCandidate,
  score: number,
  rank: number | null,
  weights: ScoringWeights,
): string[] {
  const ex = explainSimilarity(seed, cand, weights);
  const r = cand._row;
  const genres = genresOf(r);
  const head = rank !== null ? `${String(rank).padStart(2)}. ` : '    ';
  return [
    `${head}${r.artist} — ${r.title}`,
    `      score ${score.toFixed(3)}  ${genreVerdict(ex)}${recentVerdict(ex)}`,
    `      genres: ${genres?.length ? genres.join(', ') : '(none)'} · bpm ${r.bpm ?? '—'} · key ${r.key ?? '—'} · year ${r.year ?? '—'}`,
    `      ${breakdownLine(ex)}`,
  ];
}

// `parseWeightOverrides` moved to radio.service.ts (shared with
// eval-radio-poll.ts); re-exported so existing callers/tests keep their import.
export { parseWeightOverrides };

/** A genre string that looks like an un-split concatenation of several genres —
 *  no delimiter but multiple capital "humps" (e.g. "LatinWorld",
 *  "EuropopPopSoft RockElectronicRockSchlager"). The splitGenres frame parser is
 *  meant to break these apart; a hit here flags a genre-detection miss. */
export function looksConcatenatedGenre(g: string): boolean {
  const t = g.trim();
  if (t.length < 8) return false;
  if (/[;,|/]/.test(t)) return false; // has a real delimiter → splitGenres handles it
  const humps = (t.match(/[a-z][A-Z]/g) ?? []).length; // camel/Pascal boundaries
  return humps >= 1; // a mid-string capital in a long, un-delimited tag = suspicious
}

/**
 * Auto-highlight the detection params + scoring algorithm this run implicates,
 * so the dump is self-diagnosing (the whole point: turn a bad radio into a
 * concrete fix list). Reads the ranked output + pool.
 */
function renderDiagnosis(
  seed: SongFeatures,
  result: RadioResult,
  weights: ScoringWeights,
): string[] {
  const out = result.ranked;
  const n = out.length;
  let genreSkipped = 0;
  let genreZero = 0;
  let stationScored = 0;
  let keyZero = 0;
  let keyScored = 0;
  const mashed = new Set<string>();
  const consider = (cand: RadioCandidate): void => {
    const ex = explainSimilarity(seed, cand, weights);
    if (ex.axes.some((a) => a.axis === 'station')) stationScored++;
    else if (ex.skipped.includes('genre') || ex.floored.includes('genre')) genreSkipped++;
    else if (ex.axes.find((a) => a.axis === 'genre')?.value === 0) genreZero++;
    const key = ex.axes.find((a) => a.axis === 'key');
    if (key) {
      keyScored++;
      if (key.value === 0) keyZero++;
    }
    for (const g of genresOf(cand._row) ?? []) if (looksConcatenatedGenre(g)) mashed.add(g);
  };
  out.forEach((e) => consider(e.song));
  // Also scan the pool for mashed tags + the seed's own genre.
  result.pool.forEach((c) => {
    for (const g of genresOf(c._row) ?? []) if (looksConcatenatedGenre(g)) mashed.add(g);
  });
  for (const g of seed.genres ?? []) if (looksConcatenatedGenre(g)) mashed.add(g);

  const lines: string[] = ['## Detection & algorithm — improvement targets', ''];
  lines.push(
    `- **Genre-less candidates (data gap):** ${genreSkipped}/${n} output tracks had **no genre data**.`,
  );
  lines.push(
    `  They are no longer *rewarded* for it — the axis is scored at \`MISSING_GENRE_FLOOR\` (${MISSING_GENRE_FLOOR})`,
  );
  lines.push(
    `  instead of being skipped out of the normalization denominator. A high count here is now a`,
  );
  lines.push(`  **backfill** signal (re-source the genre), not a scorer bug.`);
  lines.push(
    `- **Genre lost on weight:** ${genreZero}/${n} output tracks matched nothing on genre (value 0) but still ranked.`,
  );
  if (stationScored > 0) {
    lines.push(
      `  (Not applicable to this run: ${stationScored}/${n} tracks scored the **station** axis instead —`,
    );
    lines.push(
      `  a genre station spends the genre weight on graded membership, so the two counts above are 0`,
    );
    lines.push(`  by construction. Read "Station health" for this run's genre verdict.)`);
  }
  const total = Object.entries(weights)
    .filter(([axis]) => axis !== 'artistPenalty')
    .reduce((sum, [, w]) => sum + w, 0);
  const pct = Math.round((weights.genre / total) * 100);
  lines.push(
    `  → \`DEFAULT_WEIGHTS.genre\` (currently ${weights.genre} of ${total} total ≈ ${pct}%) is too low to keep a wrong-genre`,
  );
  lines.push(`  track down; raise it or add a genre floor/co-constraint for the pool.`);
  if (mashed.size > 0) {
    lines.push(
      `- **Genre detection / splitting miss:** un-split concatenated tags found → \`splitGenres\` (tag-frame`,
    );
    lines.push(
      `  parser) isn't breaking these; genre closeness sees one giant token so nothing matches:`,
    );
    for (const m of [...mashed].slice(0, 8)) lines.push(`    - \`${m}\``);
    lines.push(
      `  → propose splits with \`reclassify-genres.ts --propose\` (segmentConcatenatedGenre), review,`,
    );
    lines.push(
      `  \`--apply\`, then \`--backfill\` to re-mint the stored sets without a full rescan.`,
    );
  }
  if (keyScored > 0) {
    lines.push(
      `- **Key detection instability:** ${keyZero}/${keyScored} scored key candidates were key-incompatible (0).`,
    );
    lines.push(
      `  A single-album/one-artist set spanning many keys signals noisy key detection dragging real`,
    );
    lines.push(
      `  neighbors down. → confidence-gate key (skip low-confidence), widen Camelot tolerance, or lower \`weights.key\`.`,
    );
  }
  lines.push('');
  return lines;
}

function renderDump(
  db: Database,
  kind: 'seed' | 'filter',
  seedRow: RadioSongRow | null,
  filter: LibraryFilter | null,
  result: RadioResult,
  weights: ScoringWeights,
): string {
  const { seed, pool, ranked } = result;
  const lines: string[] = [];
  lines.push(`# Radio diagnostic dump`);
  lines.push('');
  lines.push(`- kind: **${kind} radio**`);
  lines.push(`- seed: ${seedLabel(seedRow, seed)}`);
  if (filter) lines.push(`- filter: \`${JSON.stringify(filter)}\``);
  lines.push(`- generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Seed features');
  lines.push('```');
  lines.push(...renderSeedFeatures(seedRow, seed));
  lines.push('```');
  lines.push('');

  if (seed === null || ranked.length === 0) {
    lines.push('_No tracks generated — nothing more to report._');
    return lines.join('\n');
  }

  // Filter radio has no seed ROW, but it does have effective seed genres (the
  // requested station, or the centroid's modal primary). Reading tokens only
  // off `seedRow` reported every station candidate as "disjoint" — a pool that
  // is 100% the requested genre rendered as 100% genre-disjoint.
  const seedTokens = seedRow
    ? genreTokens(seedRow)
    : new Set(
        (effectiveGenres(seed) ?? []).flatMap((g) =>
          g
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean),
        ),
      );
  const stationLines =
    kind === 'filter' && filter ? renderStationHealth(db, filter, seed, pool) : [];

  lines.push('## Pool health');
  if (kind === 'filter' && !effectiveGenres(seed)) {
    lines.push(
      '> Note: this vibe has no genre — filter radio seeds on the pool **centroid**, so the',
    );
    lines.push(
      '> genre axis is skipped for every candidate and genre only constrains the pool via the',
    );
    lines.push('> filter `WHERE`. A bpm-only vibe has no genre cohesion by design.');
    lines.push('');
  }
  lines.push('```');
  lines.push(...renderPoolHealth(pool, seedTokens));
  lines.push('```');
  lines.push('');

  if (stationLines.length) {
    lines.push('## Station health (graded membership)');
    lines.push(
      '> Everything in a genre station\'s pool carries the tag, so "did genre match" is not the',
    );
    lines.push(
      '> question — "how many of these are actually of the genre" is. See docs/radio.md "Stations".',
    );
    lines.push('');
    lines.push('```');
    lines.push(...stationLines);
    lines.push('```');
    lines.push('');
  }

  lines.push(...renderDiagnosis(seed, result, weights));

  lines.push(`## Output — ranked top ${ranked.length}`);
  lines.push('```');
  ranked.forEach((e, i) => lines.push(...renderTrackBlock(seed, e.song, e.score, i + 1, weights)));
  lines.push('```');
  lines.push('');

  // Rejected near-misses: the highest-scoring pool tracks that did NOT make the
  // cut (score whole pool, drop the selected ids). Reveals whether real genre
  // neighbors were out-scored (weight problem) or simply weren't pooled.
  const chosen = new Set(ranked.map((e) => e.song._row.id));
  const nearMisses = pool
    .filter((c) => !chosen.has(c._row.id))
    .map((c) => ({ c, score: explainSimilarity(seed, c, weights).score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (nearMisses.length > 0) {
    lines.push('## Rejected near-misses (next 10 by score, not selected)');
    lines.push('```');
    nearMisses.forEach((m) => lines.push(...renderTrackBlock(seed, m.c, m.score, null, weights)));
    lines.push('```');
  }
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { dataDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });
  db.run('PRAGMA busy_timeout = 5000');

  const count = Math.min(Math.max(Number(firstArg(args, 'count') ?? 12), 1), 50);
  const weights = parseWeightOverrides(firstArg(args, 'weights'));
  let kind: 'seed' | 'filter';
  let seedRow: RadioSongRow | null = null;
  let filter: LibraryFilter | null = null;
  let result: RadioResult;

  try {
    const seedId = firstArg(args, 'seed');
    const artist = firstArg(args, 'artist');
    const random = args['random'] === true;
    if (random && !seedId && !artist) {
      // Random sampling: seed on any landed track (prefers one with a genre so
      // the run isn't genre-blind), to spot-check coherence across the library.
      seedRow = db
        .query<RadioSongRow, []>(
          `${RADIO_SONG_SELECT} WHERE s.hidden = 0 AND s.landed_at IS NOT NULL
           ORDER BY (s.genre IS NULL), RANDOM() LIMIT 1`,
        )
        .get();
      if (!seedRow) {
        console.error('No landed tracks in the library.');
        process.exit(1);
      }
      kind = 'seed';
      result = buildSeedRadio(db, seedRow, { count, weights });
    } else if (seedId) {
      seedRow = db.query<RadioSongRow, [string]>(`${RADIO_SONG_SELECT} WHERE s.id = ?`).get(seedId);
      if (!seedRow) {
        console.error(`Seed song ${seedId} not found.`);
        process.exit(1);
      }
      kind = 'seed';
      result = buildSeedRadio(db, seedRow, { count, weights });
    } else if (artist) {
      // Pick a landed track for the artist, preferring one that HAS a genre so
      // the seed represents the artist's tagging (else the whole run is genre-blind).
      seedRow = db
        .query<RadioSongRow, [string]>(
          `${RADIO_SONG_SELECT} WHERE LOWER(s.artist) = LOWER(?) AND s.hidden = 0 AND s.landed_at IS NOT NULL
           ORDER BY (s.genre IS NULL), RANDOM() LIMIT 1`,
        )
        .get(artist);
      if (!seedRow) {
        console.error(`No landed tracks found for artist "${artist}".`);
        process.exit(1);
      }
      kind = 'seed';
      result = buildSeedRadio(db, seedRow, { count, weights });
    } else {
      filter = filterFromArgs(args);
      if (Object.keys(filter).length === 0) {
        console.error(
          'Provide --seed <id>, --artist "<name>", or filter flags (--genre/--bpm-min/…).',
        );
        process.exit(1);
      }
      kind = 'filter';
      result = buildFilterRadio(db, filter, { count, weights });
    }

    const markdown = renderDump(db, kind, seedRow, filter, result, weights);
    const outPath = firstArg(args, 'out') ?? join(dataDir, `radio-dump-${Date.now()}.md`);
    writeFileSync(outPath, markdown + '\n');
    if (args['json'] === true) {
      const jsonPath = outPath.replace(/\.md$/, '') + '.json';
      writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            kind,
            seed: result.seed,
            poolSize: result.pool.length,
            ranked: result.ranked.map((e) => ({
              id: e.song._row.id,
              artist: e.song._row.artist,
              title: e.song._row.title,
              score: e.score,
              explanation: explainSimilarity(result.seed as SongFeatures, e.song, weights),
            })),
          },
          null,
          2,
        ) + '\n',
      );
      console.error(`Wrote ${jsonPath}`);
    }
    console.error(`Wrote ${outPath}`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main();
}
