import { Injectable, inject } from '@angular/core';
import { ListeningQueueService, type PlayEventPayload } from './listening-queue.service';
import { isTvBuild } from '../lib/platform';
import { platformId } from './native/native-capabilities';
import type { Track } from './player.service';

/**
 * A `timeupdate` gap larger than this is a seek, not elapsed listening.
 * The event fires roughly every 250ms during normal playback, so a full second
 * of slack is generous while still catching any real jump.
 */
export const MAX_DELTA_SEC = 1;

/** The in-flight listening session for the track currently on this device. */
interface Session {
  track: Track;
  startedAt: number;
  source: string | null;
  /** Accumulated real listening time, seconds. */
  listenedSec: number;
  /** Playhead position at the previous `progress()` call, seconds. */
  lastPos: number;
}

/**
 * Accumulate real listening time across a `timeupdate`.
 *
 * Only forward motion smaller than `MAX_DELTA_SEC` counts. That single rule
 * covers every case we care about:
 *
 *   - Ordinary playback advances ~0.25s per event and accrues normally.
 *   - A seek in either direction is a jump larger than the threshold, so it
 *     contributes nothing — you don't get credit for scrubbing past audio.
 *   - Replaying a section *does* accrue again (the re-listen is real playback),
 *     so `listenedSec` can exceed the track length. The server clamps stored
 *     `msPlayed` to the duration, so this only affects whether the play crosses
 *     the counting threshold — never the reported totals.
 *
 * Deliberately tolerant of nonsense input: this runs ~4×/second on every
 * playing track, and a NaN leaking into the accumulator would silently poison a
 * whole session's worth of history.
 *
 * @param prev    listened seconds accumulated so far
 * @param lastPos playhead position at the previous update, seconds
 * @param pos     playhead position now, seconds
 */
export function accumulate(prev: number, lastPos: number, pos: number): number {
  const base = Number.isFinite(prev) ? prev : 0;
  if (!Number.isFinite(lastPos) || !Number.isFinite(pos)) return base;
  const delta = pos - lastPos;
  return delta > 0 && delta <= MAX_DELTA_SEC ? base + delta : base;
}

/**
 * Owns the lifecycle of "a track is being listened to on this device".
 *
 * Fed by PlayerComponent's audio handlers, which are the only place that can
 * distinguish a real play from the several things that look like one: the
 * 30s-ahead gapless preload, an offline preserve download, a controller tab
 * mirroring a remote device's track, and a repeat-one restart that never
 * changes `currentTrack`.
 *
 * Emits one event per session into the durable outbox. Reports raw facts only;
 * the server decides whether a session counted as a play.
 *
 * See docs/listening-history.md.
 */
@Injectable({ providedIn: 'root' })
export class ListeningTrackerService {
  private queue = inject(ListeningQueueService);

  private session: Session | null = null;

  /** Begin a session. Any session still open is closed as `replaced` first. */
  start(track: Track, source: string | null = null): void {
    if (this.session) this.end('replaced');
    if (!track?.id) return;
    this.session = {
      track,
      startedAt: Date.now(),
      source,
      listenedSec: 0,
      lastPos: 0,
    };
  }

  /** Feed the current playhead position (seconds) from `timeupdate`. */
  progress(positionSec: number): void {
    const s = this.session;
    if (!s || !Number.isFinite(positionSec)) return;
    s.listenedSec = accumulate(s.listenedSec, s.lastPos, positionSec);
    s.lastPos = positionSec;
  }

  /** Close the session and queue it for reporting. No-op when none is open. */
  end(reason: PlayEventPayload['reason']): void {
    const s = this.session;
    this.session = null;
    if (!s) return;

    this.queue.enqueue({
      clientEventId: crypto.randomUUID(),
      songId: s.track.id,
      startedAt: s.startedAt,
      msPlayed: Math.round(s.listenedSec * 1000),
      durationMs: s.track.duration ? Math.round(s.track.duration * 1000) : null,
      reason,
      source: s.source,
      // Order is load-bearing: a TV build IS an Android app, so `platformId()`
      // returns 'android' there. Checking `isTvBuild()` second would silently
      // fold every TV play into Android and there would be no way to tell after
      // the fact — the column is written once, at play time.
      device: isTvBuild() ? 'tv' : platformId(),
      // Snapshotted so history survives the song-id re-mint that any file move
      // or retag causes (see docs/listening-history.md).
      title: s.track.title ?? null,
      artist: s.track.artist ?? null,
      album: s.track.album ?? null,
    });
  }

  /** True while a session is open — lets the player avoid redundant restarts. */
  isTracking(songId: string): boolean {
    return this.session?.track.id === songId;
  }
}
