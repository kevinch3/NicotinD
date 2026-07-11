import type { Database } from 'bun:sqlite';
import type { ProcessingTaskId } from '@nicotind/core';
import { MAX_ANALYSIS_ATTEMPTS } from './enrichment/analysis-failures.js';

/**
 * Per-track processing-step state, derived entirely from `library_songs` columns
 * plus the failure ledger — no separate tracking table. Powers the admin
 * "processing queue" surface so a user can see exactly which steps a fresh
 * download has been through (downloaded ✓ · bpm ✓ · key ⏳ · mood …).
 *
 *  - `done`    — the task produced its value (column populated).
 *  - `skipped` — the task permanently failed for this file (ledger at the cap),
 *                so it will never block landing.
 *  - `pending` — not done yet, still eligible to run.
 */
export type StepState = 'done' | 'pending' | 'skipped';

/** The per-song steps we surface. `download` is implicit-done (on disk). Each
 *  analysis step maps to a {@link ProcessingTaskId}. */
export interface SongSteps {
  download: 'done';
  bpm: StepState;
  key: StepState;
  energy: StepState;
  genre: StepState;
  /** The Essentia sidecar feature set (represented by danceability). */
  mood: StepState;
}

/** One quarantined song with its per-step state. */
export interface QuarantineSong {
  id: string;
  title: string;
  track: number | null;
  steps: SongSteps;
}

/** Quarantined songs grouped by their album, for the admin queue view. */
export interface QuarantineAlbum {
  albumId: string;
  albumTitle: string;
  albumArtist: string;
  songs: QuarantineSong[];
}

/** The step column tests, one per gate-capable task. Kept in sync with each
 *  EnrichmentTask.satisfiedColumnSql (a small, stable set). */
const STEP_DONE: Record<keyof Omit<SongSteps, 'download'>, (r: SongStepRow) => boolean> = {
  bpm: (r) => r.bpm !== null,
  key: (r) => r.key !== null && r.key !== '',
  energy: (r) => r.energy !== null,
  genre: (r) => r.genre !== null && r.genre !== '',
  mood: (r) => r.danceability !== null,
};

/** Which ProcessingTaskId backs each step (for the ledger lookup). */
const STEP_TASK: Record<keyof Omit<SongSteps, 'download'>, ProcessingTaskId> = {
  bpm: 'bpm',
  key: 'key',
  energy: 'energy',
  genre: 'genre',
  mood: 'audio-features',
};

interface SongStepRow {
  id: string;
  title: string;
  track: number | null;
  album_id: string;
  bpm: number | null;
  key: string | null;
  energy: number | null;
  genre: string | null;
  danceability: number | null;
}

/** Compute a song's step map from its row + the set of `${songId}:${task}` keys
 *  that are permanently failed (ledger at the attempt cap for the current file). */
export function computeSongSteps(row: SongStepRow, exhausted: Set<string>): SongSteps {
  const steps = { download: 'done' } as SongSteps;
  for (const step of Object.keys(STEP_DONE) as (keyof typeof STEP_DONE)[]) {
    if (STEP_DONE[step](row)) {
      steps[step] = 'done';
    } else if (exhausted.has(`${row.id}:${STEP_TASK[step]}`)) {
      steps[step] = 'skipped';
    } else {
      steps[step] = 'pending';
    }
  }
  return steps;
}

/**
 * Load all currently-quarantined songs (landed_at IS NULL), grouped by album,
 * with each song's per-step state. Batched: one songs query + one ledger query.
 */
export function loadQuarantineQueue(db: Database): QuarantineAlbum[] {
  const rows = db
    .query<SongStepRow & { album_name: string; album_artist: string }, []>(
      `SELECT s.id, s.title, s.track, s.album_id, s.bpm, s.key, s.energy, s.genre,
              s.danceability, a.name AS album_name, a.artist AS album_artist
         FROM library_songs s
         LEFT JOIN library_albums a ON a.id = s.album_id
        WHERE s.landed_at IS NULL AND s.hidden = 0
        ORDER BY s.created DESC NULLS LAST, s.album_id, s.track ASC NULLS LAST`,
    )
    .all();
  if (rows.length === 0) return [];

  // One ledger query for every quarantined song's permanently-failed (song,task)s.
  const exhausted = new Set<string>();
  const failRows = db
    .query<{ song_id: string; task: string }, []>(
      `SELECT song_id, task FROM library_song_analysis_failures
        WHERE fail_count >= ${MAX_ANALYSIS_ATTEMPTS}
          AND song_id IN (SELECT id FROM library_songs WHERE landed_at IS NULL)`,
    )
    .all();
  for (const f of failRows) exhausted.add(`${f.song_id}:${f.task}`);

  const byAlbum = new Map<string, QuarantineAlbum>();
  for (const r of rows) {
    let album = byAlbum.get(r.album_id);
    if (!album) {
      album = {
        albumId: r.album_id,
        albumTitle: r.album_name ?? '',
        albumArtist: r.album_artist ?? '',
        songs: [],
      };
      byAlbum.set(r.album_id, album);
    }
    album.songs.push({
      id: r.id,
      title: r.title,
      track: r.track,
      steps: computeSongSteps(r, exhausted),
    });
  }
  return [...byAlbum.values()];
}
