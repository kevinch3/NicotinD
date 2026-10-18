import type { RunnerConfig } from './config.js';
import { collectAlbumIds, loadCluster, type ArtistContext, type Cluster } from './clusters.js';
import { decide, type Decision } from './decide.js';
import { readJson, type McpLike } from './mcp-client.js';
import type { GenreModel, Verdict } from './model.js';
import { buildPrompt } from './prompt.js';
import type { AttemptStore } from './state.js';

export interface RunDeps {
  mcp: McpLike;
  model: GenreModel;
  store: AttemptStore;
  now: () => number;
  log: (line: string) => void;
}

export interface GenreMetrics {
  lowInformation: number;
  missing: number;
}

export type ClusterResult = 'applied' | 'proposed' | 'skipped' | 'dry-run' | 'refused' | 'error';

export interface ClusterOutcome {
  albumId: string;
  album: string;
  albumArtist: string;
  candidates: number;
  result: ClusterResult;
  decision: Decision | null;
  written?: number;
  verified?: number;
  note?: string;
}

export type StopReason =
  | 'worklist-exhausted'
  | 'targets-met'
  | 'budget-exhausted'
  | 'max-clusters'
  | 'time-limit'
  | 'ingest-in-progress'
  | 'model-unavailable';

export interface RunReport {
  startedAt: number;
  finishedAt: number;
  model: string;
  apply: RunnerConfig['apply'];
  dryRun: boolean;
  before: GenreMetrics;
  after: GenreMetrics;
  iterations: number;
  outcomes: ClusterOutcome[];
  stop: StopReason;
}

export class RunnerError extends Error {}

/** Consecutive model failures that end the run: the endpoint is down, not one answer bad. */
const MAX_MODEL_FAILURES = 3;
/** Distinct landings within the window that mean an ingest is still running. */
const INGEST_MIN_DISTINCT = 5;
const INGEST_WINDOW_MS = 30 * 60_000;
const MAX_CARD_SONGS = 100;

/**
 * One scheduled run: measure, work the genre worklist cluster by cluster, re-measure,
 * and go round again until a stop condition holds. Every write goes through a
 * `refiner:auto` token, so the server — not this loop — is what bounds the damage
 * a wrong verdict can do. → docs/curator-runner.md
 */
export async function runCuration(
  cfg: RunnerConfig,
  deps: RunDeps,
  opts: { dryRun: boolean },
): Promise<RunReport> {
  const { mcp, now, log } = deps;
  const instructions = await mcp.initialize();
  // A curate token would bypass every server-side policy this design relies on.
  if (!/Scope: refiner:auto\b/.test(instructions)) {
    throw new RunnerError(
      'The MCP token must have the refiner:auto scope (Settings → Agent tokens → Unattended).',
    );
  }

  const startedAt = now();
  const deadline = startedAt + cfg.maxMinutes * 60_000;
  const before = await genreMetrics(mcp);
  const report: RunReport = {
    startedAt,
    finishedAt: startedAt,
    model: `${cfg.provider}:${cfg.model}`,
    apply: cfg.apply,
    dryRun: opts.dryRun,
    before,
    after: before,
    iterations: 0,
    outcomes: [],
    stop: 'worklist-exhausted',
  };
  const finish = async (stop: StopReason) => {
    report.stop = stop;
    report.after = await genreMetrics(mcp);
    report.finishedAt = now();
    return report;
  };

  if (await ingestInProgress(mcp, now())) return finish('ingest-in-progress');

  const vocab = (await readJson<{ genres: string[] }>(mcp, 'list_genre_vocabulary')).genres;
  if (vocab.length === 0) throw new RunnerError('The library has no genre vocabulary yet.');

  const tried = new Set<string>();
  const artistCache = new Map<string, ArtistContext | null>();
  let current = before;
  let modelFailures = 0;

  for (;;) {
    report.iterations++;
    if (targetsMet(cfg.targets, current)) return finish('targets-met');
    const ids = (await collectAlbumIds(mcp)).filter(
      (id) => !tried.has(id) && !deps.store.isCoolingDown(id, now(), cfg.cooldownDays),
    );
    if (ids.length === 0) return finish('worklist-exhausted');

    for (const albumId of ids) {
      if (report.outcomes.length >= cfg.maxClusters) return finish('max-clusters');
      if (now() >= deadline) return finish('time-limit');
      tried.add(albumId);

      const cluster = await loadCluster(mcp, albumId, artistCache);
      if (!cluster || cluster.candidateIds.length === 0) {
        if (!opts.dryRun) deps.store.record(albumId, 'no-candidates', now());
        continue;
      }

      let verdicts: Verdict[];
      try {
        verdicts = await sample(deps.model, cluster, vocab, cfg.samples);
        modelFailures = 0;
      } catch (e) {
        modelFailures++;
        report.outcomes.push(outcomeOf(cluster, 'error', null, { note: errorText(e) }));
        log(`model error on ${cluster.albumName}: ${errorText(e)}`);
        if (modelFailures >= MAX_MODEL_FAILURES) return finish('model-unavailable');
        continue;
      }

      const decision = decide(verdicts, cfg.apply);
      const outcome = await act(cluster, decision, verdicts, cfg, deps, opts.dryRun);
      report.outcomes.push(outcome);
      log(
        `${outcome.result}: ${cluster.albumArtist} — ${cluster.albumName}${outcome.note ? ` (${outcome.note})` : ''}`,
      );
      if (outcome.result === 'refused' && /budget exhausted/i.test(outcome.note ?? '')) {
        return finish('budget-exhausted');
      }
      if (!opts.dryRun && outcome.result !== 'error') {
        deps.store.record(albumId, outcome.result, now());
      }
    }
    current = await genreMetrics(mcp);
  }
}

async function sample(
  model: GenreModel,
  cluster: Cluster,
  vocab: readonly string[],
  k: number,
): Promise<Verdict[]> {
  const prompt = buildPrompt(cluster, vocab);
  const verdicts: Verdict[] = [];
  for (let i = 0; i < k; i++) verdicts.push(await model.classify(prompt));
  return verdicts;
}

async function act(
  cluster: Cluster,
  decision: Decision,
  verdicts: readonly Verdict[],
  cfg: RunnerConfig,
  deps: RunDeps,
  dryRun: boolean,
): Promise<ClusterOutcome> {
  if (decision.kind === 'skip')
    return outcomeOf(cluster, 'skipped', decision, { note: decision.reason });
  if (dryRun) {
    const what =
      decision.kind === 'apply'
        ? `would write ${decision.genre}`
        : `would propose ${decision.candidates.map((c) => c.genre).join(' / ')}`;
    return outcomeOf(cluster, 'dry-run', decision, { note: what });
  }
  return decision.kind === 'apply'
    ? applyGenre(cluster, decision, deps.mcp)
    : proposeCard(cluster, decision, verdicts, cfg, deps.mcp);
}

async function applyGenre(
  cluster: Cluster,
  decision: Extract<Decision, { kind: 'apply' }>,
  mcp: McpLike,
): Promise<ClusterOutcome> {
  let written = 0;
  const refusals: string[] = [];
  for (const songId of cluster.candidateIds) {
    const res = await mcp.call('set_song_genre', {
      songId,
      genre: decision.genre,
      mode: 'replace',
    });
    if (res.ok && !res.text.includes('"error"')) {
      written++;
      continue;
    }
    if (/budget exhausted/i.test(res.text)) {
      return outcomeOf(cluster, 'refused', decision, { written, note: res.text });
    }
    refusals.push(res.text);
  }
  // `ok` is not proof of persistence (#760): read the album back.
  const after = await readJson<{
    songs: Array<{ id: string; genres?: string[]; genre: string | null }>;
  }>(mcp, 'get_album_tracks', { id: cluster.albumId });
  const wanted = decision.genre.toLowerCase();
  const verified = after.songs.filter(
    (s) =>
      cluster.candidateIds.includes(s.id) &&
      (s.genres ?? [s.genre ?? '']).map((g) => g.toLowerCase()).join('|') === wanted,
  ).length;
  return outcomeOf(cluster, 'applied', decision, {
    written,
    verified,
    ...(refusals.length > 0 ? { note: `${refusals.length} refused: ${refusals[0]}` } : {}),
  });
}

const CARD_TEXT = {
  en: (n: number, album: string) =>
    `Which genre fits the ${n} song(s) on "${album}" that have no genre or only Electronic/Dance?`,
  es: (n: number, album: string) =>
    `¿Qué género corresponde a las ${n} canciones de "${album}" sin género o solo Electronic/Dance?`,
};

async function proposeCard(
  cluster: Cluster,
  decision: Extract<Decision, { kind: 'propose' }>,
  verdicts: readonly Verdict[],
  cfg: RunnerConfig,
  mcp: McpLike,
): Promise<ClusterOutcome> {
  const songIds = cluster.candidateIds.slice(0, MAX_CARD_SONGS);
  const album =
    cluster.albumName.length > 60 ? `${cluster.albumName.slice(0, 60)}…` : cluster.albumName;
  const reason = [
    `Proposed by curator-runner (${cfg.provider}:${cfg.model}, ${verdicts.length} samples).`,
    ...verdicts.map((v, i) => `${i + 1}. ${v.genre} (${v.confidence}): ${v.evidence}`),
  ].join('\n');
  const res = await mcp.call('flag_for_review', {
    targetKind: 'album',
    targetId: cluster.albumId,
    caseKind: 'listen',
    question: CARD_TEXT[cfg.cardLanguage](songIds.length, album),
    reason,
    options: decision.candidates.map((c, i) => ({
      id: `genre-${i + 1}`,
      label: c.genre.slice(0, 80),
      rationale: `${c.votes}/${verdicts.length} samples, ${c.high} high confidence`,
      effect: { type: 'song-genre', songIds, genre: c.genre },
    })),
  });
  if (!res.ok || res.text.includes('"error"')) {
    return outcomeOf(cluster, /budget exhausted/i.test(res.text) ? 'refused' : 'error', decision, {
      note: res.text,
    });
  }
  return outcomeOf(cluster, 'proposed', decision, {
    note: decision.candidates.map((c) => c.genre).join(' / '),
  });
}

function outcomeOf(
  cluster: Cluster,
  result: ClusterResult,
  decision: Decision | null,
  extra: Partial<ClusterOutcome> = {},
): ClusterOutcome {
  return {
    albumId: cluster.albumId,
    album: cluster.albumName,
    albumArtist: cluster.albumArtist,
    candidates: cluster.candidateIds.length,
    result,
    decision,
    ...extra,
  };
}

async function genreMetrics(mcp: McpLike): Promise<GenreMetrics> {
  const health = await readJson<{
    dimensions: { genres: { metric: { lowInformation: number; missing: number } } };
  }>(mcp, 'get_library_health', { dimensions: ['genres'], sample: 1 });
  const m = health.dimensions.genres.metric;
  return { lowInformation: m.lowInformation, missing: m.missing };
}

/**
 * A page of distinct, recent landings is an arrival still in progress — a
 * "genre-less" song mid-ingest may be a partial whose tags are not in yet. One
 * identical timestamp across a page is a re-land (reorganize/transcode), not an
 * arrival, so it is distinct values that count, never rows.
 */
export async function ingestInProgress(mcp: McpLike, now: number): Promise<boolean> {
  const recent = await readJson<{ songs: Array<{ landedAt: number | null }> }>(
    mcp,
    'list_recent_songs',
    { limit: 25 },
  );
  const distinct = new Set(
    recent.songs
      .map((s) => s.landedAt)
      .filter((t): t is number => t != null && now - t < INGEST_WINDOW_MS),
  );
  return distinct.size >= INGEST_MIN_DISTINCT;
}

export function targetsMet(targets: RunnerConfig['targets'], m: GenreMetrics): boolean {
  const set = [
    targets.lowInformation != null ? m.lowInformation <= targets.lowInformation : null,
    targets.missing != null ? m.missing <= targets.missing : null,
  ].filter((v): v is boolean => v != null);
  return set.length > 0 && set.every(Boolean);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
