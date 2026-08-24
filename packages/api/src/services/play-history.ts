import type { Database } from 'bun:sqlite';
import { recordingKey } from './recording-identity.js';

/**
 * Listening history — the write + read side of the `play_events` log.
 *
 * Clients report **raw facts** about a playback session (which song, when it
 * started, how many ms were actually listened to, how it ended). This module
 * owns the one interpretation of those facts: whether the session counts as a
 * play.
 *
 * That rule lives here rather than on the client on purpose. If a client
 * decided "this counted", the threshold could never be retuned without
 * invalidating existing history, and a device running an old bundle would
 * disagree with a fresh one forever. Same discipline as `explainSimilarity`
 * being the single source of truth for radio scoring.
 *
 * See docs/listening-history.md.
 */

/** Below this, a track is a jingle/interlude and never counts. */
export const MIN_TRACK_MS = 30_000;
/** Ceiling on the "half the track" requirement, so long tracks stay reachable. */
export const MAX_REQUIRED_MS = 240_000;
/** Refuse to ingest an unbounded batch from a user-writable endpoint. */
export const MAX_EVENTS_PER_BATCH = 200;

const REASONS = ['ended', 'skipped', 'replaced', 'stopped'] as const;
export type PlayReason = (typeof REASONS)[number];

export interface PlayEventInput {
  clientEventId: string;
  songId: string;
  startedAt: number;
  msPlayed: number;
  durationMs: number | null;
  reason: PlayReason;
  source: string | null;
  device: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
}

export interface RecordResult {
  inserted: number;
  duplicates: number;
  rejected: number;
}

export interface RecentPlay {
  songId: string;
  /** Live library title where the song still exists, else the event snapshot. */
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  /** Live cover-art id (`library_songs.cover_art`) for `/api/cover/:id`. */
  coverArt: string | null;
  playedAt: number;
}

/**
 * The Last.fm rule: a session counts once it has played half the track or four
 * minutes, whichever comes first.
 *
 * The 50% floor is what makes a skip not count; the 4-minute ceiling is what
 * keeps a 20-minute live take from being effectively unplayable. An unknown
 * duration falls back to the ceiling alone — that is the only threshold we can
 * justify without knowing how long the track is.
 */
export function countsAsPlay(msPlayed: number, durationMs: number | null): boolean {
  if (!Number.isFinite(msPlayed) || msPlayed <= 0) return false;
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) {
    return msPlayed >= MAX_REQUIRED_MS;
  }
  if (durationMs < MIN_TRACK_MS) return false;
  return msPlayed >= Math.min(durationMs / 2, MAX_REQUIRED_MS);
}

function isUsable(e: PlayEventInput): boolean {
  return (
    typeof e?.clientEventId === 'string' &&
    e.clientEventId.length > 0 &&
    typeof e.songId === 'string' &&
    e.songId.length > 0 &&
    Number.isFinite(e.startedAt) &&
    Number.isFinite(e.msPlayed) &&
    (REASONS as readonly string[]).includes(e.reason)
  );
}

/**
 * A client can send anything, so bound what we store: never more listened-time
 * than the track is long, never a negative, never an absurd duration.
 */
function sanitize(e: PlayEventInput): PlayEventInput {
  const durationMs =
    e.durationMs !== null && Number.isFinite(e.durationMs) && e.durationMs > 0
      ? Math.round(e.durationMs)
      : null;
  const played = Math.max(0, Math.round(e.msPlayed));
  return {
    ...e,
    durationMs,
    msPlayed: durationMs === null ? played : Math.min(played, durationMs),
  };
}

/**
 * Append a batch. Idempotent on `clientEventId` — the client buffers events
 * durably and retries a failed flush, so the same event legitimately arrives
 * twice and must not become two plays.
 */
export function recordPlayEvents(
  db: Database,
  userId: string,
  events: PlayEventInput[],
): RecordResult {
  const batch = (Array.isArray(events) ? events : []).slice(0, MAX_EVENTS_PER_BATCH);
  const usable = batch.filter(isUsable).map(sanitize);
  const rejected = batch.length - usable.length;

  const insert = db.query(
    `INSERT OR IGNORE INTO play_events
       (client_event_id, user_id, song_id, title, artist, album,
        at, ms_played, duration_ms, counted, reason, source, device)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  db.transaction(() => {
    for (const e of usable) {
      insert.run(
        e.clientEventId,
        userId,
        e.songId,
        e.title,
        e.artist,
        e.album,
        Math.round(e.startedAt),
        e.msPlayed,
        e.durationMs,
        countsAsPlay(e.msPlayed, e.durationMs) ? 1 : 0,
        e.reason,
        e.source,
        e.device,
      );
      const changed = db.query<{ n: number }, []>(`SELECT changes() AS n`).get();
      if (changed && changed.n > 0) inserted += 1;
    }
  })();

  return { inserted, duplicates: usable.length - inserted, rejected };
}

/**
 * The caller's recently listened tracks, most recent first, collapsed to one
 * row per *recording* — a track owned on its album and on a compilation is two
 * rows, and it used to take two tiles here and count twice in keep-vibe's
 * `seedCentroid` (issue #660). Only counted plays — a track you skipped after
 * four seconds is not something you listened to, and surfacing it would make
 * the shelf useless on a night of heavy skipping.
 *
 * Joined to `library_songs` and restricted to songs that are still live,
 * landed and unhidden: this feeds a shelf whose whole purpose is to be tapped,
 * and a tile that can't play is worse than an absent one. The raw log keeps the
 * deleted rows regardless — a year review reads that, not this.
 *
 * Live title/artist win over the event snapshot so a retag is reflected here,
 * with the snapshot as the fallback (see the schema comment on why it exists).
 *
 * Scoped to `userId` with no way to ask for anyone else's: listening history is
 * private, and that is structural here rather than a check at the route.
 */
export function recentPlays(db: Database, userId: string, limit: number): RecentPlay[] {
  const size = Math.min(Math.max(Math.trunc(limit) || 0, 1), 100);
  // Over-fetch, then collapse: two rows of one recording must not take two
  // tiles, and collapsing *after* a LIMIT would silently return a short shelf.
  const seen = new Set<string>();
  return db
    .query<
      {
        song_id: string;
        title: string | null;
        artist: string | null;
        artist_id: string;
        album: string | null;
        duration: number | null;
        cover_art: string | null;
        played_at: number;
      },
      [string, number]
    >(
      `SELECT p.song_id                          AS song_id,
              COALESCE(s.title, p.title)         AS title,
              COALESCE(s.artist, p.artist)       AS artist,
              s.artist_id                        AS artist_id,
              COALESCE(al.name, p.album)         AS album,
              s.duration                         AS duration,
              s.cover_art                        AS cover_art,
              MAX(p.at)                          AS played_at
         FROM play_events p
         JOIN library_songs s   ON s.id = p.song_id
    LEFT JOIN library_albums al ON al.id = s.album_id
        WHERE p.user_id = ?
          AND p.counted = 1
          AND s.hidden = 0
          AND s.landed_at IS NOT NULL
          AND (al.hidden IS NULL OR al.hidden = 0)
        GROUP BY p.song_id
        ORDER BY played_at DESC
        LIMIT ?`,
    )
    .all(userId, Math.min(size * 2, 100))
    .filter((r) => {
      const key = recordingKey(r.artist_id, r.title ?? '', r.duration ?? 0);
      if (!key) return true; // unidentifiable never groups — not even with another
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, size)
    .map((r) => ({
      songId: r.song_id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      duration: r.duration,
      coverArt: r.cover_art,
      playedAt: r.played_at,
    }));
}

/**
 * Total rows, for the admin ServiceReview slice. Retention policy for this
 * table is deliberately "keep everything until a measurement says otherwise"
 * (docs/listening-history.md), and this is the measurement.
 */
export function playEventCount(db: Database): number {
  const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM play_events`).get();
  return row?.n ?? 0;
}

/**
 * When this listener last played each *recording* in the window, epoch ms.
 * Recordings never played are simply absent from the map.
 *
 * Keyed on the recording rather than the song id because one recording can be
 * two rows — the album copy and the compilation copy. Under the old id-keyed
 * map, hearing one left the other at zero demotion, so a duplicated track kept
 * coming straight back; on prod it was served 1.99x as often as a single-file
 * one (issue #660).
 *
 * Queried from the *play* side rather than the pool side. That is both simpler
 * and cheaper than passing several hundred candidate ids back in: the window
 * predicate is served by `idx_play_events_user_at`, the row count is "distinct
 * songs this listener played in the window" rather than the pool size, and
 * anything older already decays to zero in `recentPlayFactor` so it never
 * needed reading. It also joins `library_songs`, which the id-keyed version did
 * not: a play whose row has since been pruned drops out, which is right here
 * (there is no candidate to demote) but is a real behaviour change.
 *
 * Per-user by construction: `library_songs` is global but listening is not, so
 * a global play count would blend everyone on a shared server — wrong for a
 * personal radio and a privacy regression besides.
 *
 * Counts **every** play event, not just `counted = 1`: for "don't replay this
 * so soon", starting a track and bailing still means you just heard it. That is
 * the opposite of what the stats aggregates want, which is why this doesn't
 * reuse their filter.
 */
export function lastPlayedByRecording(
  db: Database,
  userId: string,
  now: number,
  windowMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const rows = db
    .query<
      { title: string; artist_id: string; duration: number; last_at: number },
      [string, number]
    >(
      `SELECT s.title AS title, s.artist_id AS artist_id, s.duration AS duration,
              MAX(p.at) AS last_at
         FROM play_events p
         JOIN library_songs s ON s.id = p.song_id
        WHERE p.user_id = ? AND p.at >= ?
        GROUP BY p.song_id`,
    )
    .all(userId, now - windowMs);

  for (const r of rows) {
    const key = recordingKey(r.artist_id, r.title, r.duration);
    if (!key) continue;
    const prev = out.get(key);
    if (prev === undefined || r.last_at > prev) out.set(key, r.last_at);
  }
  return out;
}
