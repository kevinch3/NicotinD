import { Injectable, effect, inject, untracked } from '@angular/core';
import { PlayerService } from './player.service';
import { PreserveService } from './preserve.service';
import { SetupService } from './setup.service';
import type { Track } from './player.service';

/**
 * Bridges PlayerService queue state → PreserveService.
 *
 * Watches `[currentTrack, ...queue]` and asks PreserveService to keep the next
 * N tracks (per `preserve.autoPreserveMode()`) on disk. The PWA's locked-
 * screen failure mode is that the browser throttles in-flight `/api/stream`
 * Range requests on backgrounded tabs — pre-buffering the bytes into IndexedDB
 * means the player sources them as fully-local `blob:` URLs and is unaffected
 * by screen lock or network state.
 *
 * The effect tracks ONLY connectivity, mode, the current track and the queue.
 * The call into PreserveService runs `untracked`: its synchronous prefix reads
 * `preservedIds` and `preserving` and then writes `preserving`, so a tracked
 * call subscribed the effect to its own writes. Every failed fetch (offline it
 * rejects in milliseconds) cleared `preserving`, re-ran the effect and fetched
 * the same track again — a tight loop that pinned the CPU and the radio, which
 * an iOS PWA user felt as the phone getting very hot offline.
 */
@Injectable({ providedIn: 'root' })
export class AutoPreserveCoordinator {
  private player = inject(PlayerService);
  private preserve = inject(PreserveService);
  private setup = inject(SetupService);

  constructor() {
    let wasOffline = false;
    effect(() => {
      // Offline (no network, or the server unreachable) every fetch is doomed:
      // ask for nothing. Tracked, so the reconnect re-runs this and resumes.
      if (this.setup.isOffline()) {
        wasOffline = true;
        return;
      }
      if (wasOffline) {
        wasOffline = false;
        untracked(() => this.preserve.forgetAutoPreserveFailures());
      }

      const mode = this.preserve.autoPreserveMode();
      const current = this.player.currentTrack();
      const queue = this.player.queue();
      if (mode === 'off' || (!current && queue.length === 0)) return;

      const window: Track[] = current ? [current, ...queue] : queue;
      const needed = this.preserve.windowSize(window.length);
      const target = needed > 0 ? window.slice(0, needed) : [];
      if (target.length === 0) return;

      // Fire-and-forget — preserve failures are non-fatal. Untracked: see the
      // class comment for the loop a tracked call caused.
      untracked(() => void this.preserve.ensureAutoPreservedFor(target));
    });
  }
}
