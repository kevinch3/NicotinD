/**
 * On-visit completion of one artist's page data (#1855): bio, origin and
 * portrait, each only when it is still missing and due. The background tasks
 * stay the sweep for artists nobody opens; this is the same work, done now for
 * the artist someone is looking at. → docs/library-scanner.md (#213, #1855)
 */
import type { Database } from 'bun:sqlite';
import { lidarrCircuit, type Lidarr } from '../lidarr/index.js';
import { getArtistMeta } from './artist-meta-store.js';
import {
  fillArtistImages,
  NEEDS_PORTRAIT_SQL,
  PORTRAIT_RETRY_TTL_MS,
  recordPortraitAttempts,
  type ArtistImageFillDeps,
} from './artist-image-fill.js';
import {
  fillArtistOrigin,
  ORIGIN_PENDING_WHERE,
  ORIGIN_RECHECK_TTL_MS,
} from './enrichment/tasks.js';
import type { MbidCorroboration } from './enrichment/tasks.js';

export type CompletionField = 'bio' | 'origin' | 'portrait';

export interface ArtistCompleteDeps {
  /** The bio step (`fetchAndStoreArtistInfo`); it also resolves and stores the MBID. */
  fetchInfo: ((artist: { id: string; name: string }) => Promise<{ kind: 'ok' | 'error' }>) | null;
  origin: {
    lidarr: Lidarr | null | undefined;
    lookupArtistOrigin: (mbid: string) => Promise<{ ok: boolean; country: string | null }>;
    corroboration?: MbidCorroboration;
  } | null;
  portrait: ArtistImageFillDeps | null;
  now?: () => number;
}

export interface ArtistCompletion {
  /** Fields this call wrote a value for — the page re-reads only when non-empty. */
  filled: CompletionField[];
}

/** Which steps are due for this artist, read from the same predicates the tasks use. */
export function dueCompletionSteps(
  db: Database,
  artistId: string,
  now = Date.now(),
): Set<CompletionField> {
  const due = new Set<CompletionField>();
  if (!getArtistMeta(db, artistId)) due.add('bio');
  const origin = db
    .query<{ n: number }, [number, string]>(
      `SELECT 1 AS n FROM library_artists a WHERE ${ORIGIN_PENDING_WHERE} AND a.id = ?`,
    )
    .get(now - ORIGIN_RECHECK_TTL_MS, artistId);
  if (origin) due.add('origin');
  const portrait = db
    .query<{ n: number }, [string, number]>(
      `SELECT 1 AS n FROM library_artists a WHERE ${NEEDS_PORTRAIT_SQL} AND a.id = ?
         AND a.id NOT IN (SELECT artist_id FROM artist_portrait_attempts WHERE attempted_at > ?)`,
    )
    .get(artistId, now - PORTRAIT_RETRY_TTL_MS);
  if (portrait) due.add('portrait');
  return due;
}

const inFlight = new Map<string, Promise<ArtistCompletion>>();

/**
 * Run every due step for one artist. Concurrent calls for the same artist share
 * one run. The bio runs first because it resolves and stores the MBID the origin
 * then reads; origin and portrait run in parallel (MusicBrainz vs Lidarr).
 */
export function completeArtist(
  db: Database,
  deps: ArtistCompleteDeps,
  artist: { id: string; name: string },
): Promise<ArtistCompletion> {
  const running = inFlight.get(artist.id);
  if (running) return running;
  const run = runCompletion(db, deps, artist).finally(() => inFlight.delete(artist.id));
  inFlight.set(artist.id, run);
  return run;
}

async function runCompletion(
  db: Database,
  deps: ArtistCompleteDeps,
  artist: { id: string; name: string },
): Promise<ArtistCompletion> {
  const now = deps.now ?? Date.now;
  const due = dueCompletionSteps(db, artist.id, now());
  const filled: CompletionField[] = [];

  if (due.has('bio') && deps.fetchInfo) {
    const res = await deps.fetchInfo(artist).catch(() => ({ kind: 'error' as const }));
    const meta = getArtistMeta(db, artist.id);
    if (res.kind === 'ok' && meta?.bio) filled.push('bio');
  }

  const steps: Promise<void>[] = [];
  if (due.has('origin') && deps.origin) {
    const origin = deps.origin;
    steps.push(
      fillArtistOrigin(db, origin, artist)
        .then((r) => {
          if (r.status === 'filled') filled.push('origin');
        })
        .catch(() => undefined),
    );
  }
  if (due.has('portrait') && deps.portrait) {
    const portrait = deps.portrait;
    steps.push(
      (async () => {
        const startedAt = now();
        const { applied } = await fillArtistImages(db, portrait, [artist]);
        if (applied > 0) {
          filled.push('portrait');
          return;
        }
        // An outage is not an absence (#1581): no retry stamp when Lidarr failed.
        const lastFailure = lidarrCircuit(portrait.lidarr)?.lastFailureAt ?? null;
        if (lastFailure === null || lastFailure < startedAt) {
          recordPortraitAttempts(db, [artist.id], now());
        }
      })().catch(() => undefined),
    );
  }
  await Promise.all(steps);
  return { filled };
}
