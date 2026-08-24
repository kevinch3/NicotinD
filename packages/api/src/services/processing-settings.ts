import type { Database } from 'bun:sqlite';
import type { ProcessingSettings, ProcessingTaskId } from '@nicotind/core';

/** Patch shape: top-level optional, with partial nested tasks/gates (deep-merged). */
export type ProcessingSettingsPatch = Partial<Omit<ProcessingSettings, 'tasks' | 'gates'>> & {
  tasks?: Partial<Record<ProcessingTaskId, boolean>>;
  gates?: Partial<Record<ProcessingTaskId, boolean>>;
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
  // Steps that must finish before a fresh download is added to the library.
  // Fast, offline, no-sidecar analysis (bpm/key/energy) plus genre are gated by
  // default; genre auto-skips when Lidarr is absent (never blocks). Mood/
  // audio-features (sidecar, off on fresh installs) and per-artist artist-image
  // are intentionally NOT gates, so nothing extra is required out of the box.
  gates: {
    bpm: true,
    key: true,
    energy: true,
    genre: true,
  },
  // Not paused by default; the admin "Pause now" toggle flips this at runtime.
  paused: false,
  // Hold quarantined downloads until explicitly reviewed (issue #411).
  holdForReview: false,
};

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
    return {
      enabled: parsed.enabled ?? DEFAULT_PROCESSING_SETTINGS.enabled,
      paused: parsed.paused ?? DEFAULT_PROCESSING_SETTINGS.paused,
      holdForReview: parsed.holdForReview ?? DEFAULT_PROCESSING_SETTINGS.holdForReview,
      // Nested objects must deep-merge so an older/partial blob can't drop a field.
      tasks: { ...DEFAULT_PROCESSING_SETTINGS.tasks, ...parsed.tasks },
      gates: { ...DEFAULT_PROCESSING_SETTINGS.gates, ...parsed.gates },
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
  const next: ProcessingSettings = {
    ...current,
    ...patch,
    tasks: { ...current.tasks, ...patch.tasks },
    gates: { ...current.gates, ...patch.gates },
  };
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify(next)],
  );
  return next;
}

function clone(s: ProcessingSettings): ProcessingSettings {
  return {
    ...s,
    tasks: { ...s.tasks },
    gates: { ...s.gates },
  };
}
