/**
 * Measure ListenBrainz similar-artists against this library (issue #1486), before
 * anything is built on it. STRICTLY read-only on the database; the only network
 * calls go to ListenBrainz labs, one per sampled artist, 1 req/s.
 *
 *   # locally, against your dev DB
 *   bun run packages/api/src/scripts/measure-similar-artists.ts --sample 100
 *   # against prod (kpc)
 *   ssh kpc 'docker exec -i nicotind-nicotind-1 sh -lc "cat > /tmp/m.ts && bun /tmp/m.ts --sample 100"' \
 *     < packages/api/src/scripts/measure-similar-artists.ts
 *
 * Answers the issue's "measure first" questions: for how many library artists does
 * the algorithm return anything, how much of what it returns is already in the
 * library (the radio axis) versus not (the discovery hook), and what the score
 * scale looks like, the input to calibrating it against cosine (the #1119 shape).
 *
 * Flags: --sample N (default 100) · --json · --db <path> · --algorithm <name>
 * Env: NICOTIND_DATA_DIR (default /data/nicotind in-container).
 * Self-contained on purpose (no workspace imports), so it runs from a single
 * file piped into the container.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
const LB_LABS = 'https://labs.api.listenbrainz.org/similar-artists/json';
const USER_AGENT = 'NicotinD (+https://github.com/kevinch3/nicotind)';

export interface SimilarArtist {
  mbid: string;
  name: string;
  score: number;
}

export interface ArtistMeasurement {
  mbid: string;
  /** null when the request failed, as distinct from an empty answer. */
  results: SimilarArtist[] | null;
}

/** One labs call; `null` on any failure so an outage never reads as "no neighbours". */
export async function fetchSimilar(
  mbid: string,
  fetchFn: typeof fetch = fetch,
  algorithm = DEFAULT_ALGORITHM,
): Promise<SimilarArtist[] | null> {
  try {
    const url = `${LB_LABS}?artist_mbids=${encodeURIComponent(mbid)}&algorithm=${algorithm}`;
    const res = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return null;
    return body
      .filter(
        (r): r is { artist_mbid: string; name: string; score: number } =>
          typeof r?.artist_mbid === 'string' && typeof r?.score === 'number',
      )
      .filter((r) => r.artist_mbid !== mbid)
      .map((r) => ({ mbid: r.artist_mbid, name: String(r.name ?? ''), score: r.score }));
  } catch {
    return null;
  }
}

const quantile = (sorted: number[], q: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null;

export interface SimilarArtistsSummary {
  sampled: number;
  failed: number;
  /** Answered with at least one neighbour, over the artists that answered at all. */
  withResults: number;
  coveragePct: number | null;
  medianResults: number | null;
  /** Of all neighbours returned, the share already in the library (the radio axis). */
  inLibraryPct: number | null;
  /** Same, over each artist's top 10 only: what a radio pick would actually reach. */
  top10InLibraryPct: number | null;
  /** Artists whose top 10 holds at least one library artist. */
  usableForRadioPct: number | null;
  /** Score scale, for calibration: p10 / p50 / p90 of each artist's best score. */
  topScore: { p10: number | null; p50: number | null; p90: number | null };
}

export function summarize(
  rows: readonly ArtistMeasurement[],
  libraryMbids: ReadonlySet<string>,
): SimilarArtistsSummary {
  const answered = rows.filter((r) => r.results !== null);
  const withResults = answered.filter((r) => r.results!.length > 0);
  const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
  let all = 0;
  let owned = 0;
  let top = 0;
  let topOwned = 0;
  let usable = 0;
  for (const r of withResults) {
    const res = r.results!;
    all += res.length;
    owned += res.filter((s) => libraryMbids.has(s.mbid)).length;
    const top10 = [...res].sort((a, b) => b.score - a.score).slice(0, 10);
    top += top10.length;
    const t = top10.filter((s) => libraryMbids.has(s.mbid)).length;
    topOwned += t;
    if (t > 0) usable++;
  }
  const counts = withResults.map((r) => r.results!.length).sort((a, b) => a - b);
  const best = withResults
    .map((r) => Math.max(...r.results!.map((s) => s.score)))
    .sort((a, b) => a - b);
  return {
    sampled: rows.length,
    failed: rows.length - answered.length,
    withResults: withResults.length,
    coveragePct: pct(withResults.length, answered.length),
    medianResults: quantile(counts, 0.5),
    inLibraryPct: pct(owned, all),
    top10InLibraryPct: pct(topOwned, top),
    usableForRadioPct: pct(usable, answered.length),
    topScore: { p10: quantile(best, 0.1), p50: quantile(best, 0.5), p90: quantile(best, 0.9) },
  };
}

/** Deterministic spread over the key order, so two runs sample the same artists. */
export function spreadSample<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]!);
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dbPath =
    argValue(argv, '--db') ??
    join(process.env.NICOTIND_DATA_DIR ?? '/data/nicotind', 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath} (set NICOTIND_DATA_DIR or pass --db).`);
    process.exit(1);
  }
  const sample = Number(argValue(argv, '--sample') ?? 100);
  const algorithm = argValue(argv, '--algorithm') ?? DEFAULT_ALGORITHM;

  const db = new Database(dbPath, { readonly: true });
  let artists: Array<{ mbid: string }>;
  try {
    artists = db
      .query(`SELECT DISTINCT mbid FROM library_mbids WHERE scope = 'artist' ORDER BY key`)
      .all() as Array<{ mbid: string }>;
  } finally {
    db.close();
  }
  const libraryMbids = new Set(artists.map((a) => a.mbid));
  const picked = spreadSample(artists, Number.isFinite(sample) && sample > 0 ? sample : 100);

  const rows: ArtistMeasurement[] = [];
  for (const [i, a] of picked.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    rows.push({ mbid: a.mbid, results: await fetchSimilar(a.mbid, fetch, algorithm) });
    if (!argv.includes('--json')) process.stderr.write(`\r${i + 1}/${picked.length}`);
  }
  const summary = { libraryArtistMbids: libraryMbids.size, ...summarize(rows, libraryMbids) };
  if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else {
    process.stderr.write('\n');
    console.log(`# similar-artists vs library — ${dbPath} (read-only)\n`);
    for (const [k, v] of Object.entries(summary)) console.log(`${k}: ${JSON.stringify(v)}`);
  }
}

if (import.meta.main) {
  await main();
}
