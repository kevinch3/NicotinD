import { Injectable, effect, inject } from '@angular/core';
import { PlayerService } from './player.service';
import { PreserveService } from './preserve.service';
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
 * Reads signals (not the player API surface) so the coordinator runs cheaply
 * on every queue mutation. `untracked` is used only inside the no-dependency
 * helper below to keep the effect from subscribing to its own writes.
 */
@Injectable({ providedIn: 'root' })
export class AutoPreserveCoordinator {
  private player = inject(PlayerService);
  private preserve = inject(PreserveService);

  constructor() {
    effect(() => {
      const mode = this.preserve.autoPreserveMode();
      const current = this.player.currentTrack();
      const queue = this.player.queue();
      if (mode === 'off' || (!current && queue.length === 0)) return;

      const window: Track[] = current ? [current, ...queue] : queue;
      const needed = this.preserve.windowSize(window.length);
      const target = needed > 0 ? window.slice(0, needed) : [];
      if (target.length === 0) return;

      // Fire-and-forget — preserve failures are non-fatal and the effect must
      // not re-fire on its own write to the preserving/preservedIds signals.
      void this.preserve.ensureAutoPreservedFor(target);
    });
  }
}