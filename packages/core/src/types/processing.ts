/**
 * Library-processing (enrichment) contracts. The background processor runs
 * enabled enrichment *tasks* (BPM, genre today; mood/etc. later) over songs that
 * still need them, continuously while enabled. Settings and status are surfaced
 * in the admin Settings panel.
 */

/**
 * Every enrichment task that exists today — new tasks append here, retired ones
 * are deleted here. It is a runtime array, not just a union, because two places
 * need to ask "is this string still a task?" at run time: the persisted
 * settings blob and the per-(song, task) failure ledger both outlive the code
 * that wrote them. When the licence feature was rolled back (#683) neither
 * could tell, so its key stayed in `app_settings.processing` and its 16,063
 * ledger rows stayed the largest occupant of a table nothing read them from
 * (#779). The union is derived from this so the two can never drift.
 */
export const PROCESSING_TASK_IDS = [
  'bpm',
  'genre',
  'key',
  'artist-image',
  'artist-info',
  'energy',
  'audio-features',
  'descriptors',
  'artist-identity',
  'genre-audio',
  'genre-discogs',
  'popularity',
  'artist-origin',
] as const;

/** Identifier of an enrichment task. */
export type ProcessingTaskId = (typeof PROCESSING_TASK_IDS)[number];

/** Persisted, admin-editable processing configuration. */
export interface ProcessingSettings {
  /** Master switch — when off the processor never runs. */
  enabled: boolean;
  /** Per-task enable flags. A task only runs when enabled here AND available. */
  tasks: Record<ProcessingTaskId, boolean>;
  /**
   * Per-task "must complete before the song is added to the library" flags. A
   * gated task holds a freshly-downloaded song in quarantine (present in the DB
   * but hidden from every listing) until it produces its value, exhausts its
   * failure ledger, or the safety-valve age elapses. A task only *gates* landing
   * when it is gated here AND enabled AND available — so an off/unavailable task
   * (e.g. the sidecar on a fresh install) can never strand a download. Sparse:
   * absent id ⇒ not a gate. Kept separate from `tasks` so an admin can run a task
   * in the background without it blocking landing, and vice-versa.
   */
  gates: Partial<Record<ProcessingTaskId, boolean>>;
  /**
   * Temporary halt of automatic background enrichment. Unlike `enabled: false`
   * (a persistent off switch), `paused` is a runtime throttle: fresh downloads
   * still clear their landing gate (so nothing is stranded in quarantine), but
   * no background enrichment runs. An explicit admin "Run now" still overrides
   * it. It is also the manual way to stand down while another tenant needs the
   * GPU, since the automatic courtesy yield was removed.
   */
  paused: boolean;
  /**
   * Hold quarantined downloads until a curator explicitly approves them
   * (download inbox, #411). Independent of enrichment gates: applies even when
   * the landing gate task list is empty or NICOTIND_DISABLE_LANDING_GATE is set.
   */
  holdForReview: boolean;
}

/** Coarse phase of the processor at a point in time. */
export type ProcessingPhase = 'idle' | 'running' | 'disabled' | 'paused';

/** Live status snapshot for the progress UI (persisted so a restart resumes display). */
export interface ProcessingStatus {
  phase: ProcessingPhase;
  /** Task currently being worked, or null when idle. */
  currentTask: ProcessingTaskId | null;
  /** Items enriched in the current/last run. */
  processed: number;
  /** Items that failed to enrich in the current/last run (decode/sidecar errors). */
  failed: number;
  /** A representative failure reason from the current/last run (ffmpeg stderr
   *  tail, sidecar error, …), or null when the run had no failures. */
  lastError: string | null;
  /** Total pending across enabled tasks at the start of the run (denominator). */
  total: number;
  /** Most-recent enriched item labels (newest last), capped for display. */
  lastItems: string[];
  /** ISO timestamp the current/last run started, or null. */
  startedAt: string | null;
  /** ISO timestamp of the last status update. */
  updatedAt: string | null;
  /** Pending count per task right now (the resumable predicate count). */
  taskPending: Record<ProcessingTaskId, number>;
  /** Per-task availability: `true` if runnable, else a human reason it can't run. */
  availability: Record<ProcessingTaskId, true | string>;
  /**
   * Ids an admin may require before a download lands. Declared by the task
   * itself (`EnrichmentTask.gateable`), not inferred — so the panel can hide a
   * control it would otherwise offer inertly, or worse, offer for a task that
   * must never hold a download hostage (#691). Absent on a status blob written
   * before this field existed; treat that as "no information", not "none".
   */
  gateable?: ProcessingTaskId[];
  /** Distinct files excluded from processing after repeated hard decode failures
   *  (corrupt/unreadable); auto-cleared when the file is repaired (size change). */
  skipped: number;
  /** Songs currently quarantined — scanned into the DB but withheld from every
   *  library listing until their required processing (gate) steps complete. */
  quarantined: number;
}
