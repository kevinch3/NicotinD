import type { Database } from 'bun:sqlite';
import {
  PROCESSING_TASK_IDS,
  type ProcessingSettings,
  type ProcessingTaskId,
} from '@nicotind/core';

/** Patch shape: top-level optional, with partial nested tasks (deep-merged). */
export type ProcessingSettingsPatch = Partial<Omit<ProcessingSettings, 'tasks'>> & {
  tasks?: Partial<Record<ProcessingTaskId, boolean>>;
};

/**
 * Persistence for the library-processing config. Same `app_settings` key/value
 * JSON pattern as streaming-settings.ts — not user-scoped.
 */

const KEY = 'processing';

export const DEFAULT_PROCESSING_SETTINGS: ProcessingSettings = {
  enabled: true,
  tasks: {
    bpm: true,
    genre: true,
    key: true,
    'artist-image': true,
    // Discogs (or future) artist bio/genre lookup for the artist-info task
    // (issue #195). Per-artist, never a gate — same posture as artist-image.
    'artist-info': true,
    energy: true,
    'audio-features': true,
    // Timbre/groove/band descriptors from the sidecar's /descriptors
    // (docs/audio-descriptors.md) — ~5 s CPU per track, stored raw for the
    // composite radio axes. Default-on, never a gate.
    descriptors: true,
    // Resolves compound artist strings (bands/duos vs collabs) via Lidarr/MB so the
    // scanner can split them; auto-skips when Lidarr is absent. Per-artist, never a gate.
    'artist-identity': true,
    // Audio-inferred genre fallback (issue #187 task A2) — runs only when the
    // `genre` task above has nothing; confidence-gated, never a gate itself
    // (a weak classifier must never strand a fresh download).
    'genre-audio': true,
    // Album-scoped Discogs genre enrichment (issue #194) — runs over songs the
    // Lidarr `genre` task left genre-less, writes gated library_genre_overrides.
    // Off by default (needs the consent-gated Discogs extension configured) and
    // never a gate (a metadata source must not strand a fresh download).
    'genre-discogs': false,
    // Extrinsic popularity from ListenBrainz (issue #220) — a 0–1 hotness scalar
    // keyed on the recording MBID. No creds, MBID-native. Default-on, never a
    // gate (an extrinsic network signal must never strand a fresh download).
    popularity: true,
    // Artist origin country from MusicBrainz (docs/artist-origin.md). Per-artist,
    // one cached MB call under the shared 1 req/s limiter, never a gate.
    'artist-origin': true,
  },
  // Not paused by default; the admin "Pause now" toggle flips this at runtime.
  paused: false,
};

const LIVE_TASK_IDS = new Set<string>(PROCESSING_TASK_IDS);

/**
 * Keep only flags for tasks that still exist. The field-by-field read below
 * protects the TOP level from a retired key; this protects one level down,
 * where `licence` survived its own rollback and was re-persisted on every save
 * (#683 / #779). Allowlisted against the live task ids.
 */
function liveTaskFlags(
  stored: Partial<Record<string, boolean>> | undefined,
): Partial<Record<ProcessingTaskId, boolean>> {
  const out: Partial<Record<ProcessingTaskId, boolean>> = {};
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (LIVE_TASK_IDS.has(key)) out[key as ProcessingTaskId] = value;
  }
  return out;
}

export function getProcessingSettings(db: Database): ProcessingSettings {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY);
  if (!row) return clone(DEFAULT_PROCESSING_SETTINGS);
  try {
    const parsed = JSON.parse(row.value) as Partial<ProcessingSettings>;
    // Field-by-field, never `...parsed`: a stored blob predating the removal of
    // the processing window and the compute regulator still carries `window`/
    // `batchSize`/`concurrency`/`gpuBusyPercent`, and a bare spread would copy
    // them onto the result (invisible to TS as excess properties) and re-persist
    // them on the next write, so the API would keep emitting retired fields.
    // The landing gate's `gates` / `holdForReview` keys are the latest retirees.
    return {
      enabled: parsed.enabled ?? DEFAULT_PROCESSING_SETTINGS.enabled,
      paused: parsed.paused ?? DEFAULT_PROCESSING_SETTINGS.paused,
      // Nested objects must deep-merge so an older/partial blob can't drop a field.
      tasks: { ...DEFAULT_PROCESSING_SETTINGS.tasks, ...liveTaskFlags(parsed.tasks) },
    };
  } catch {
    return clone(DEFAULT_PROCESSING_SETTINGS);
  }
}

export function setProcessingSettings(
  db: Database,
  patch: ProcessingSettingsPatch,
): ProcessingSettings {
  const current = getProcessingSettings(db);
  // Field-by-field for the same reason as the reader: a client still sending
  // a retired top-level key must not get it persisted back into the blob.
  const next: ProcessingSettings = {
    enabled: patch.enabled ?? current.enabled,
    paused: patch.paused ?? current.paused,
    tasks: { ...current.tasks, ...liveTaskFlags(patch.tasks) },
  };
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify(next)],
  );
  return next;
}

function clone(s: ProcessingSettings): ProcessingSettings {
  return { ...s, tasks: { ...s.tasks } };
}
