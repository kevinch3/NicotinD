import type { Database } from 'bun:sqlite';
import type { ProcessingSettings, ProcessingTaskId, ProcessingWindow } from '@nicotind/core';

/** Patch shape: top-level optional, with partial nested tasks/gates/window (deep-merged). */
export type ProcessingSettingsPatch = Partial<
  Omit<ProcessingSettings, 'tasks' | 'gates' | 'window'>
> & {
  tasks?: Partial<Record<ProcessingTaskId, boolean>>;
  gates?: Partial<Record<ProcessingTaskId, boolean>>;
  window?: Partial<ProcessingWindow>;
};

/**
 * Persistence for the windowed library-processing config. Same `app_settings`
 * key/value JSON pattern as streaming-settings.ts — not user-scoped.
 */

const KEY = 'processing';

export const DEFAULT_PROCESSING_SETTINGS: ProcessingSettings = {
  enabled: true,
  window: { start: '05:00', end: '08:00' },
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
    // Resolves compound artist strings (bands/duos vs collabs) via Lidarr/MB so the
    // scanner can split them; auto-skips when Lidarr is absent. Per-artist, never a gate.
    'artist-identity': true,
    // Fills the rights/licence code from file tags → MusicBrainz. Optional source,
    // never a gate (see below) — a fresh download lands without waiting on it.
    licence: true,
    // Audio-inferred genre fallback (issue #187 task A2) — runs only when the
    // `genre` task above has nothing; confidence-gated, never a gate itself
    // (a weak classifier must never strand a fresh download).
    'genre-audio': true,
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
  batchSize: 25,
  concurrency: 3,
};

export function getProcessingSettings(db: Database): ProcessingSettings {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY);
  if (!row) return clone(DEFAULT_PROCESSING_SETTINGS);
  try {
    const parsed = JSON.parse(row.value) as Partial<ProcessingSettings>;
    return {
      ...DEFAULT_PROCESSING_SETTINGS,
      ...parsed,
      // Nested objects must deep-merge so an older/partial blob can't drop a field.
      window: { ...DEFAULT_PROCESSING_SETTINGS.window, ...parsed.window },
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
    window: { ...current.window, ...patch.window },
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
    window: { ...s.window },
    tasks: { ...s.tasks },
    gates: { ...s.gates },
  };
}
