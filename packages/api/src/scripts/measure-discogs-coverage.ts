/**
 * Discogs genre-coverage measurement spike (#191) — dev-only, **READ-ONLY**.
 *
 * A throwaway measurement that decides whether the Discogs genre integration is
 * worth building. It answers ONE decision-relevant question — not "does Discogs
 * match MusicBrainz?" (parity is worth zero; we already have MB) but:
 *
 *   > Of the songs still genre-less after #187's A1 shipped (the residual gap),
 *   > how many does Discogs resolve — via release genres, via release styles?
 *
 * Nothing ships from this issue except the committed report
 * (docs/measurements/discogs-coverage-2026-07.md). This script is the harness:
 * its **pure parts** (URL building, response mapping, normalization, scoring,
 * cohort tally) are unit-tested with an injected fetch and run in CI; the **live
 * API run is manual** (needs a Discogs Consumer Key + Secret and the real
 * library) and is NOT in CI. No DB writes.
 *
 *   # register a free app at discogs.com/settings/developers, then:
 *   DISCOGS_KEY=… DISCOGS_SECRET=… bun run \
 *     packages/api/src/scripts/measure-discogs-coverage.ts --limit 25 --out docs/measurements/discogs-coverage-2026-07.md
 *
 * Flags: --limit N (residual-cohort albums to probe, default 25), --out <path>
 *        (write the markdown report; default: print to stdout), --key/--secret
 *        (override the DISCOGS_KEY/DISCOGS_SECRET env).
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG (locate the library DB).
 *
 * Deliberately **self-contained** ("No plugin code" — the Discogs *plugin* is
 * #193): the small prober below duplicates a few primitives on purpose so this
 * spike is independently reviewable and disposable.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { normalizeArtistForGrouping, albumGroupKey } from '../services/album-grouping.js';
import { getMbid } from '../services/mbid-store.js';

export const DISCOGS_API = 'https://api.discogs.com';
export const MB_API = 'https://musicbrainz.org/ws/2';
export const USER_AGENT =
  'NicotinD-DiscogsCoverageSpike/1.0 (+https://github.com/kevinch3/nicotind)';
/** With key+secret Discogs allows 60/min; self-throttle to 55 (no Retry-After on 429). */
const MIN_INTERVAL_MS = Math.ceil(60_000 / 55);
const MAX_ATTEMPTS = 3;

export interface DiscogsAuth {
  consumerKey: string;
  consumerSecret: string;
}

// ─────────────────────────── pure: normalization ───────────────────────────

/** Fold an artist name for comparison (accent-insensitive, keeps punctuation). */
export function foldArtist(s: string): string {
  return normalizeArtistForGrouping(s);
}

/** Fold a release title for comparison (accent-insensitive, punctuation-light). */
export function foldTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trim + drop empties + de-duplicate a genre/style list (case-insensitive). */
export function normalizeGenreList(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values ?? []) {
    const t = v.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// ─────────────────────────── pure: URL building ────────────────────────────

/** Discogs `/database/search` URL for a release name search (auth is a header). */
export function buildSearchUrl(base: string, q: { artist: string; album: string }): string {
  const params = new URLSearchParams({
    artist: q.artist,
    release_title: q.album,
    type: 'release',
    per_page: '10',
  });
  return `${base}/database/search?${params.toString()}`;
}

export interface DiscogsRef {
  kind: 'release' | 'master';
  id: number;
}

/** Discogs entity URL for a resolved ref. */
export function buildEntityUrl(base: string, ref: DiscogsRef): string {
  return `${base}/${ref.kind === 'master' ? 'masters' : 'releases'}/${ref.id}`;
}

/** MusicBrainz release-group URL including url-relations (for the discogs link). */
export function buildMbReleaseGroupUrl(base: string, mbid: string): string {
  return `${base}/release-group/${encodeURIComponent(mbid)}?inc=url-rels&fmt=json`;
}

// ─────────────────────────── pure: ref parsing ─────────────────────────────

/** Extract a Discogs `{ kind, id }` from a Discogs entity URL (human or API). */
export function parseDiscogsRef(url: string): DiscogsRef | null {
  const m = url.match(/\/(releases?|masters?)\/(\d+)/i);
  if (!m) return null;
  return {
    kind: m[1]!.toLowerCase().startsWith('master') ? 'master' : 'release',
    id: Number(m[2]),
  };
}

/** Pull the `discogs` url-relation target out of a MusicBrainz release-group JSON. */
export function extractDiscogsRelationUrl(mbJson: {
  relations?: Array<{ type?: string; url?: { resource?: string } }>;
}): string | null {
  for (const rel of mbJson.relations ?? []) {
    if (rel.type === 'discogs' && rel.url?.resource) return rel.url.resource;
  }
  return null;
}

// ─────────────────────────── pure: response mapping ────────────────────────

export interface DiscogsSearchHit {
  id: number;
  type: string;
  title: string;
}

/** Extract + de-duplicate genres and styles from a fetched release/master. */
export function mapReleaseGenres(json: { genres?: string[]; styles?: string[] }): {
  genres: string[];
  styles: string[];
} {
  return { genres: normalizeGenreList(json.genres), styles: normalizeGenreList(json.styles) };
}

/** Split a Discogs "Artist - Title" hit into its two folded halves. */
function splitHitTitle(title: string): { artist: string; album: string } {
  const idx = title.indexOf(' - ');
  if (idx === -1) return { artist: '', album: foldTitle(title) };
  return { artist: foldArtist(title.slice(0, idx)), album: foldTitle(title.slice(idx + 3)) };
}

/**
 * Score a hit in [0, 1]; both artist AND album must corroborate. A right-artist
 * wrong-album hit scores 0 — the album-title corroboration that stops the
 * "Emilia (Argentine) → Emilia (Swedish)" false match #187 hit during its own
 * measurement.
 */
export function scoreHit(query: { artist: string; album: string }, hit: DiscogsSearchHit): number {
  const wantArtist = foldArtist(query.artist);
  const wantAlbum = foldTitle(query.album);
  const got = splitHitTitle(hit.title);
  const artistScore =
    got.artist === wantArtist ? 1 : got.artist && wantArtist.includes(got.artist) ? 0.6 : 0;
  const albumScore =
    got.album === wantAlbum
      ? 1
      : wantAlbum && got.album && (got.album.includes(wantAlbum) || wantAlbum.includes(got.album))
        ? 0.6
        : 0;
  if (artistScore === 0 || albumScore === 0) return 0;
  return 0.5 * artistScore + 0.5 * albumScore;
}

/** Best release/master hit at/above the floor (master wins ties), or null. */
export function pickBestHit(
  query: { artist: string; album: string },
  hits: readonly DiscogsSearchHit[],
  minConfidence = 0.5,
): { ref: DiscogsRef; confidence: number } | null {
  let best: { ref: DiscogsRef; confidence: number } | null = null;
  for (const hit of hits) {
    if (hit.type !== 'release' && hit.type !== 'master') continue;
    const confidence = scoreHit(query, hit);
    if (confidence < minConfidence) continue;
    const ref: DiscogsRef = { kind: hit.type, id: hit.id };
    if (
      !best ||
      confidence > best.confidence ||
      (confidence === best.confidence && ref.kind === 'master' && best.ref.kind === 'release')
    ) {
      best = { ref, confidence };
    }
  }
  return best;
}

// ─────────────────────────── pure: cohort tally ────────────────────────────

export interface CaseResult {
  artist: string;
  album: string;
  /** How the match was made: 'mbid' | 'name' | null (unresolved). */
  via: 'mbid' | 'name' | null;
  genres: string[];
  styles: string[];
  requests: number;
  error?: string;
}

export interface CohortTally {
  residual: number;
  resolvedByGenres: number;
  resolvedByStyles: number;
  resolvedByEither: number;
}

/** Roll up per-case results into the report's cohort table numbers. */
export function tallyCohort(results: readonly CaseResult[]): CohortTally {
  const tally: CohortTally = {
    residual: results.length,
    resolvedByGenres: 0,
    resolvedByStyles: 0,
    resolvedByEither: 0,
  };
  for (const r of results) {
    const byGenres = r.genres.length > 0;
    const byStyles = r.styles.length > 0;
    if (byGenres) tally.resolvedByGenres++;
    if (byStyles) tally.resolvedByStyles++;
    if (byGenres || byStyles) tally.resolvedByEither++;
  }
  return tally;
}

// ─────────────────────────── I/O: the prober ───────────────────────────────

export interface ProbeDeps {
  auth: DiscogsAuth;
  fetchFn?: typeof fetch;
  /** Injected so tests don't wait on the real self-throttle interval. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  discogsBase?: string;
  mbBase?: string;
}

interface FetchOutcome {
  status: number;
  json: unknown;
  remaining: number | null;
}

/**
 * Minimal Discogs (+ MusicBrainz relation) prober for the spike. Injectable
 * fetch/sleep so the pure-ish request flow (retry on 429/5xx, User-Agent on
 * every request, self-throttle) is testable without network. Counts requests so
 * the report can size the rate-limit budget honestly.
 */
export class DiscogsCoverageProbe {
  requests = 0;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly discogsBase: string;
  private readonly mbBase: string;
  private lastCallAt = 0;

  constructor(private deps: ProbeDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.discogsBase = deps.discogsBase ?? DISCOGS_API;
    this.mbBase = deps.mbBase ?? MB_API;
  }

  private discogsHeaders(): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      Authorization: `Discogs key=${this.deps.auth.consumerKey}, secret=${this.deps.auth.consumerSecret}`,
      Accept: 'application/json',
    };
  }

  /** One throttled, retrying GET. Returns null on 404 / exhausted transient failure. */
  private async get(url: string, headers: Record<string, string>): Promise<unknown | null> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.throttle();
      this.requests++;
      const res = await this.fetchFn(url, { headers });
      const outcome = await this.readOutcome(res);
      if (outcome.remaining != null && outcome.remaining <= 1) await this.sleep(MIN_INTERVAL_MS);
      if (outcome.status === 404) return null;
      if (outcome.status === 429 || outcome.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(MIN_INTERVAL_MS * attempt);
          continue;
        }
        return null; // persistent transient failure — ledger a miss, not a match
      }
      if (outcome.status < 200 || outcome.status >= 300) return null;
      return outcome.json;
    }
    return null;
  }

  private async readOutcome(res: unknown): Promise<FetchOutcome> {
    const r = res as {
      status: number;
      json(): Promise<unknown>;
      headers?: { get(name: string): string | null };
    };
    const remainingRaw = r.headers?.get('X-Discogs-Ratelimit-Remaining');
    const remaining = remainingRaw != null && remainingRaw !== '' ? Number(remainingRaw) : null;
    let json: unknown = null;
    try {
      json = await r.json();
    } catch {
      /* non-JSON body */
    }
    return { status: r.status, json, remaining: Number.isFinite(remaining) ? remaining : null };
  }

  private async throttle(): Promise<void> {
    const elapsed = this.now() - this.lastCallAt;
    if (this.lastCallAt > 0 && elapsed < MIN_INTERVAL_MS)
      await this.sleep(MIN_INTERVAL_MS - elapsed);
    this.lastCallAt = this.now();
  }

  /** MBID-first: MB release-group url-relation → Discogs ref (or null). */
  async mbidToDiscogsRef(mbid: string): Promise<DiscogsRef | null> {
    const json = await this.get(buildMbReleaseGroupUrl(this.mbBase, mbid), {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    });
    if (!json) return null;
    const url = extractDiscogsRelationUrl(json as Parameters<typeof extractDiscogsRelationUrl>[0]);
    return url ? parseDiscogsRef(url) : null;
  }

  async searchRelease(query: { artist: string; album: string }): Promise<DiscogsSearchHit[]> {
    const json = await this.get(buildSearchUrl(this.discogsBase, query), this.discogsHeaders());
    const results = (json as { results?: DiscogsSearchHit[] } | null)?.results;
    return Array.isArray(results) ? results : [];
  }

  async entityGenres(ref: DiscogsRef): Promise<{ genres: string[]; styles: string[] }> {
    const json = await this.get(buildEntityUrl(this.discogsBase, ref), this.discogsHeaders());
    return json
      ? mapReleaseGenres(json as { genres?: string[]; styles?: string[] })
      : { genres: [], styles: [] };
  }

  /** Probe one residual case end to end: MBID-first, then corroborated name search. */
  async probeCase(c: {
    artist: string;
    album: string;
    albumMbid?: string | null;
  }): Promise<CaseResult> {
    const before = this.requests;
    const base: CaseResult = {
      artist: c.artist,
      album: c.album,
      via: null,
      genres: [],
      styles: [],
      requests: 0,
    };
    try {
      if (c.albumMbid) {
        const ref = await this.mbidToDiscogsRef(c.albumMbid);
        if (ref) {
          const g = await this.entityGenres(ref);
          if (g.genres.length || g.styles.length) {
            return { ...base, via: 'mbid', ...g, requests: this.requests - before };
          }
        }
      }
      const hits = await this.searchRelease(c);
      const match = pickBestHit(c, hits);
      if (match) {
        const g = await this.entityGenres(match.ref);
        if (g.genres.length || g.styles.length) {
          return { ...base, via: 'name', ...g, requests: this.requests - before };
        }
      }
      return { ...base, requests: this.requests - before };
    } catch (err) {
      return {
        ...base,
        requests: this.requests - before,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─────────────────────────── I/O: DB cohort ────────────────────────────────

export interface CohortCase {
  artist: string;
  album: string;
  albumMbid: string | null;
}

/**
 * The residual gap: distinct albums that still own a genre-less landed song
 * after A1, most-affected first — the exact cohort the pass criterion asks
 * about. Read-only. The named regression anchors (#187's José Larralde / Emilia)
 * are always included via {@link NAMED_CASES}.
 */
export function selectResidualCohort(db: Database, limit: number): CohortCase[] {
  const rows = db
    .query<{ album: string; artist: string }, [number]>(
      `SELECT al.name AS album, al.artist AS artist
         FROM library_albums al
         JOIN library_songs s ON s.album_id = al.id
        WHERE s.landed_at IS NOT NULL AND (s.genre IS NULL OR s.genre = '')
        GROUP BY al.id
        ORDER BY COUNT(*) DESC, al.name
        LIMIT ?`,
    )
    .all(limit);
  return rows.map((r) => ({
    artist: r.artist,
    album: r.album,
    albumMbid: getMbid(db, 'album', albumGroupKey(r.artist, r.album))?.mbid ?? null,
  }));
}

/** #187's named checks — always probed so the numbers stay directly comparable. */
export const NAMED_CASES: ReadonlyArray<{ artist: string; album: string; note: string }> = [
  {
    artist: 'José Larralde',
    album: 'Herencia Para un Hijo Gaucho',
    note: "#187's unmet A1 criterion — does Discogs carry Folk / Folclore / Chamamé where MB gave Latin;World?",
  },
  {
    artist: 'Emilia',
    album: 'Tú Crees en Mí',
    note: 'Same-name false-match guard — must resolve the Argentine Emilia, not the Swedish one (album-title corroboration).',
  },
];

// ─────────────────────────── report rendering ──────────────────────────────

/** Render the cohort table + per-case detail as the committed markdown report. */
export function renderReport(input: {
  tally: CohortTally;
  cases: readonly CaseResult[];
  named: readonly CaseResult[];
  totalRequests: number;
  elapsedMs: number;
}): string {
  const { tally, cases, named, totalRequests, elapsedMs } = input;
  const pct = (n: number) => (tally.residual ? `${Math.round((100 * n) / tally.residual)}%` : '—');
  const lines: string[] = [];
  lines.push('## Result (live run)', '');
  lines.push('| Cohort | Resolved |', '|---|---|');
  lines.push(`| Songs genre-less after A1 (the residual gap) | ${tally.residual} |`);
  lines.push(
    `| …of those, resolved by Discogs release genres | ${tally.resolvedByGenres} (${pct(tally.resolvedByGenres)}) |`,
  );
  lines.push(
    `| …of those, resolved by Discogs release styles | ${tally.resolvedByStyles} (${pct(tally.resolvedByStyles)}) |`,
  );
  lines.push(
    `| …of those, resolved by either | ${tally.resolvedByEither} (${pct(tally.resolvedByEither)}) |`,
  );
  lines.push(
    '',
    `**Budget:** ${totalRequests} requests, ${(elapsedMs / 1000).toFixed(1)}s wall-clock.`,
    '',
  );
  lines.push('### Named cases', '');
  for (const c of named) lines.push(`- **${c.artist} — ${c.album}** → ${describeCase(c)}`);
  lines.push('', '### Residual cohort detail', '');
  for (const c of cases) lines.push(`- ${c.artist} — ${c.album} → ${describeCase(c)}`);
  return lines.join('\n') + '\n';
}

function describeCase(c: CaseResult): string {
  if (c.error) return `error: ${c.error}`;
  if (!c.via) return 'unresolved';
  const parts: string[] = [];
  if (c.genres.length) parts.push(`genres: ${c.genres.join(', ')}`);
  if (c.styles.length) parts.push(`styles: ${c.styles.join(', ')}`);
  return `[${c.via}] ${parts.join(' · ') || 'no genres/styles'}`;
}

// ─────────────────────────── I/O: main ─────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadDataDir(): string {
  let fileConfig: Record<string, unknown> = {};
  try {
    fileConfig = (parse(
      readFileSync(resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml'), 'utf-8'),
    ) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  return expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const auth: DiscogsAuth = {
    consumerKey: argValue('--key') ?? process.env.DISCOGS_KEY ?? '',
    consumerSecret: argValue('--secret') ?? process.env.DISCOGS_SECRET ?? '',
  };
  if (!auth.consumerKey || !auth.consumerSecret) {
    console.error(
      'Missing credentials. Register an app at discogs.com/settings/developers, then set\n' +
        'DISCOGS_KEY + DISCOGS_SECRET (or pass --key/--secret). Anonymous is 25/min with images stripped.',
    );
    process.exit(1);
  }
  const limit = Number(argValue('--limit') ?? 25);
  const dbPath = join(loadDataDir(), 'library.db');
  if (!existsSync(dbPath)) {
    console.error(`No library DB at ${dbPath}. Set NICOTIND_DATA_DIR/NICOTIND_CONFIG.`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });
  const cohort = selectResidualCohort(db, limit);
  const named = NAMED_CASES.map((n) => ({ artist: n.artist, album: n.album, albumMbid: null }));
  console.error(
    `Probing ${cohort.length} residual albums + ${named.length} named cases against Discogs (self-throttled ~55/min)…`,
  );

  const probe = new DiscogsCoverageProbe({ auth });
  const started = Date.now();
  const cohortResults: CaseResult[] = [];
  for (const c of cohort) cohortResults.push(await probe.probeCase(c));
  const namedResults: CaseResult[] = [];
  for (const c of named) namedResults.push(await probe.probeCase(c));

  const report = renderReport({
    tally: tallyCohort(cohortResults),
    cases: cohortResults,
    named: namedResults,
    totalRequests: probe.requests,
    elapsedMs: Date.now() - started,
  });
  const out = argValue('--out');
  if (out) {
    writeFileSync(out, report);
    console.error(`Wrote report to ${out}.`);
  } else {
    console.log(report);
  }
}

if (import.meta.main) {
  void main();
}
