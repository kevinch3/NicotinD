import { Injectable, inject, signal, computed } from '@angular/core';
import { SystemApiService } from './api/system-api.service';
import type { SetupStatus } from './api/api-types';
import { NetworkStatusService } from './network-status.service';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SetupService {
  private api = inject(SystemApiService);
  private network = inject(NetworkStatusService);

  readonly status = signal<SetupStatus | null>(null);
  readonly checked = signal(false);
  // "Device reports a live network but the server didn't answer" — distinct from
  // being disconnected. Set by the boot probe; the two are OR-folded below.
  private readonly serverUnreachable = signal(false);

  // Offline == no live network OR the server is unreachable. A `computed` reads
  // like a plain signal, so every existing `setup.isOffline()` call site is
  // unchanged — but it now recomputes when connectivity flips in EITHER direction
  // mid-session, so the whole UI (library source swap, nav gating, offline
  // banner, redirects) reacts live instead of being frozen at boot time.
  readonly isOffline = computed(() => !this.network.online() || this.serverUnreachable());

  async check(): Promise<void> {
    // Fast path: the device already reports offline, so skip the HTTP probe
    // entirely. This kills the multi-second blank-screen boot (and the flurry of
    // failing offline requests) that caused the Android release to ANR/crash on
    // an offline launch — `isOffline` is already true via the network signal.
    if (!this.network.online()) {
      this.checked.set(true);
      return;
    }
    try {
      const status = await firstValueFrom(this.api.getSetupStatus().pipe(timeout(3000)));
      this.status.set(status);
      this.serverUnreachable.set(false);
    } catch {
      // Network says online but the server didn't answer — treat as offline.
      this.serverUnreachable.set(true);
    }
    this.checked.set(true);
  }

  /** Records that setup just finished so redirects treat the app as configured. */
  markComplete(): void {
    this.status.set({ needsSetup: false });
  }
}
