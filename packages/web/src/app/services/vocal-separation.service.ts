import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { StemApiService } from './api/stem-api.service';
import type { StemStatus } from './api/api-types';
import { PlayerService } from './player.service';
import { ToastService } from './toast.service';
import { TranslateService } from './translate.service';

/**
 * ML vocal separation for karaoke (issue #603) — the client-side state machine
 * between the mute toggle, the stem prepare/status endpoint and the player.
 *
 * The one idea: **the mute is intent, readiness decides the URL.**
 * `PlayerService.vocalsMuted` keeps meaning "the listener wants vocals off"
 * (it persists across tracks, as before). Whether a given track is actually
 * served with `?vocals=off` right now is `shouldServeVocalsOff(id)`:
 *
 *   muted AND ( the stem is ready                         → the ML instrumental
 *             | this track cannot get one (unavailable /   → the basic filter
 *               failed, or the instance has no separator) )
 *
 * Everything else while muted is "pending": the original mix keeps playing
 * (owner decision on #603 — never dead air, never a mid-song downgrade) until
 * the stem lands, at which point the player swaps the source at the same
 * position. There is no separate pending flag: pending is simply "muted but
 * not yet servable", so toggling twice cancels it and a track change while
 * muted needs no special case.
 *
 * Triggers: the current track is prepared when the karaoke overlay opens or
 * the mute is on; while muted the next queued track is prepared too, so the
 * wait usually happens once per session. Nothing outside a karaoke session.
 */
export type StemState =
  | { state: 'unknown' }
  | { state: 'idle' }
  | { state: 'unavailable'; reason: string }
  | { state: 'queued'; queuePosition: number; etaSec: number; receivedAt: number }
  | { state: 'preparing'; etaSec: number; receivedAt: number }
  | { state: 'ready' }
  | { state: 'failed'; reason: 'rejected' | 'transient' };

export type VocalMode = 'off' | 'pending' | 'ml' | 'basic';

export const STEM_POLL_INTERVAL_MS = 2_000;
/** Re-ask the server about an `unavailable`/transient track no more often than this. */
const REASK_AFTER_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class VocalSeparationService {
  private readonly api = inject(StemApiService);
  private readonly player = inject(PlayerService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  /** The fullscreen karaoke overlay is open (set by NowPlayingComponent). */
  readonly karaokeOpen = signal(false);
  readonly stems = signal<ReadonlyMap<string, StemState>>(new Map());
  /** Learned from the first real answer: false = this instance has no usable separator. */
  readonly mlAvailable = signal<boolean | null>(null);
  /** 1 s heartbeat so the ETA counts down between polls. */
  private readonly tick = signal(0);
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly polling = new Set<string>();
  private readonly askedAt = new Map<string, number>();
  private readonly toasted = new Set<string>();

  readonly sessionActive = computed(() => this.karaokeOpen() || this.player.vocalsMuted());

  readonly currentStem = computed<StemState>(
    () => this.stems().get(this.player.currentTrack()?.id ?? '') ?? { state: 'unknown' },
  );

  /** What the player should request for the current track — its reload trigger. */
  readonly currentServeVocalsOff = computed(() => {
    const id = this.player.currentTrack()?.id;
    return id ? this.shouldServeVocalsOff(id) : false;
  });

  readonly vocalMode = computed<VocalMode>(() => {
    if (!this.player.vocalsMuted()) return 'off';
    if (!this.currentServeVocalsOff()) return 'pending';
    return this.currentStem().state === 'ready' ? 'ml' : 'basic';
  });

  readonly etaSec = computed<number | null>(() => {
    this.tick();
    const s = this.currentStem();
    if (s.state !== 'queued' && s.state !== 'preparing') return null;
    return Math.max(1, Math.ceil(s.etaSec - (Date.now() - s.receivedAt) / 1000));
  });

  readonly queuePosition = computed<number | null>(() => {
    const s = this.currentStem();
    return s.state === 'queued' ? s.queuePosition : null;
  });

  constructor() {
    // Prepare: the current track while the overlay is open or the mute is on;
    // the next queued track while muted (ML only — nothing to prepare otherwise).
    effect(() => {
      const current = this.player.currentTrack()?.id;
      const next = this.player.queue()[0]?.id;
      const muted = this.player.vocalsMuted();
      const open = this.karaokeOpen();
      untracked(() => {
        if (current && (open || muted)) this.prepare(current);
        if (muted && next && this.mlAvailable() !== false) this.prepare(next);
      });
    });

    // A failed separation degrades that track to the basic filter; say so once.
    effect(() => {
      const id = this.player.currentTrack()?.id;
      const s = this.currentStem();
      if (!id || !this.player.vocalsMuted() || s.state !== 'failed') return;
      untracked(() => {
        if (this.toasted.has(id)) return;
        this.toasted.add(id);
        this.toast.show({
          kind: 'info',
          message: this.translate.t('nowPlaying.vocalSeparationFailed'),
        });
      });
    });

    // The countdown heartbeat runs only while something is pending on screen.
    effect(() => {
      const pending = this.vocalMode() === 'pending' || this.karaokeOpen();
      untracked(() => (pending ? this.startTick() : this.stopTick()));
    });

    this.destroyRef.onDestroy(() => this.stopTick());
  }

  setKaraokeOpen(open: boolean): void {
    this.karaokeOpen.set(open);
  }

  /** Whether `?vocals=off` should be requested for `trackId` right now. */
  shouldServeVocalsOff(trackId: string): boolean {
    if (!this.player.vocalsMuted()) return false;
    const s = this.stems().get(trackId);
    if (s) {
      if (s.state === 'ready') return true;
      if (s.state === 'unavailable' || s.state === 'failed') return true;
      return false;
    }
    // Never asked about this track: basic only when ML is known to be absent.
    return this.mlAvailable() === false;
  }

  /** Idempotent: ask the server to prepare `trackId`, then follow it to a terminal state. */
  prepare(trackId: string): void {
    const s = this.stems().get(trackId);
    if (this.polling.has(trackId)) return;
    if (s?.state === 'ready' || (s?.state === 'failed' && s.reason === 'rejected')) return;
    if (s && (s.state === 'unavailable' || s.state === 'failed')) {
      const asked = this.askedAt.get(trackId) ?? 0;
      if (Date.now() - asked < REASK_AFTER_MS) return;
    }
    if (this.mlAvailable() === false && !s) {
      // Known basic-only instance: don't hammer the server per track.
      const asked = this.askedAt.get(trackId) ?? 0;
      if (Date.now() - asked < REASK_AFTER_MS) return;
    }
    this.askedAt.set(trackId, Date.now());
    this.polling.add(trackId);
    this.api.prepare(trackId).subscribe({
      next: (status) => {
        this.polling.delete(trackId);
        this.apply(trackId, status);
        this.schedulePoll(trackId);
      },
      error: () => {
        this.polling.delete(trackId);
        this.apply(trackId, { state: 'failed', reason: 'transient' });
      },
    });
  }

  private schedulePoll(trackId: string): void {
    const s = this.stems().get(trackId);
    if (!s || (s.state !== 'queued' && s.state !== 'preparing')) return;
    if (!untracked(() => this.sessionActive())) return;
    this.polling.add(trackId);
    setTimeout(() => {
      if (!untracked(() => this.sessionActive())) {
        this.polling.delete(trackId);
        return;
      }
      this.api.status(trackId).subscribe({
        next: (status) => {
          this.polling.delete(trackId);
          this.apply(trackId, status);
          this.schedulePoll(trackId);
        },
        error: () => {
          this.polling.delete(trackId);
          this.apply(trackId, { state: 'failed', reason: 'transient' });
        },
      });
    }, STEM_POLL_INTERVAL_MS);
  }

  private apply(trackId: string, status: StemStatus): void {
    const receivedAt = Date.now();
    let next: StemState;
    switch (status.state) {
      case 'queued':
        next = { ...status, receivedAt };
        break;
      case 'preparing':
        next = { ...status, receivedAt };
        break;
      case 'failed':
        next = { state: 'failed', reason: status.reason };
        break;
      default:
        next = status;
    }
    if (status.state === 'unavailable') {
      // Structural reasons describe the instance; a busy/unhealthy sidecar is
      // still an instance with ML, so only the former settles `mlAvailable`.
      if (
        status.reason === 'not-configured' ||
        status.reason === 'disabled' ||
        status.reason === 'no-ffmpeg'
      ) {
        this.mlAvailable.set(false);
      }
    } else if (status.state !== 'idle') {
      this.mlAvailable.set(true);
    }
    this.stems.update((m) => {
      const copy = new Map(m);
      copy.set(trackId, next);
      return copy;
    });
  }

  private startTick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick.update((n) => n + 1), 1_000);
  }

  private stopTick(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
}
