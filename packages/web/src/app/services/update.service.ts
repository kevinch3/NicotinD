import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter, map, of } from 'rxjs';

export type CheckUpdateOutcome = 'unavailable' | 'available' | 'up-to-date';

@Injectable({ providedIn: 'root' })
export class UpdateService {
  private sw = inject(SwUpdate);

  /** False on dev builds, native shells, or browsers without service worker support. */
  readonly enabled = signal(this.sw.isEnabled);

  /** True while a manual `SwUpdate.checkForUpdate()` is in flight. Gates duplicate clicks. */
  readonly searching = signal(false);

  /** Sticky "an update is ready" flag. Sourced directly from the SW version
   * stream via `toSignal` — no manual subscription/teardown. `toSignal` retains
   * the last emitted value, so once VERSION_READY maps to `true` it stays true. */
  readonly updateAvailable = toSignal(
    this.sw.isEnabled
      ? this.sw.versionUpdates.pipe(
          filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'),
          map(() => true),
        )
      : of(false),
    { initialValue: false },
  );

  /** Convenience for templates that want to render the manual control. */
  readonly checkAvailable = computed(() => this.enabled() && !this.updateAvailable());

  async checkForUpdate(): Promise<CheckUpdateOutcome> {
    if (!this.enabled()) return 'unavailable';
    if (this.searching()) return 'unavailable';
    this.searching.set(true);
    try {
      const found = await this.sw.checkForUpdate();
      return found ? 'available' : 'up-to-date';
    } finally {
      this.searching.set(false);
    }
  }

  async applyUpdate(): Promise<void> {
    await this.sw.activateUpdate();
    if (typeof document !== 'undefined') document.location.reload();
  }
}
