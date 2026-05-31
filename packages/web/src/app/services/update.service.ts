import { Injectable, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter, map, of } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UpdateService {
  private sw = inject(SwUpdate);

  /**
   * Sticky "an update is ready" flag. Sourced directly from the SW version
   * stream via `toSignal` — no manual subscription/teardown. `toSignal` retains
   * the last emitted value, so once VERSION_READY maps to `true` it stays true.
   */
  readonly updateAvailable = toSignal(
    this.sw.isEnabled
      ? this.sw.versionUpdates.pipe(
          filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'),
          map(() => true),
        )
      : of(false),
    { initialValue: false },
  );

  async applyUpdate(): Promise<void> {
    await this.sw.activateUpdate();
    document.location.reload();
  }
}
