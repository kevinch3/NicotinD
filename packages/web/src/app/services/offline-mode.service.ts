import { Injectable, computed, inject, signal } from '@angular/core';
import { NetworkStatusService } from './network-status.service';

/**
 * Whether the app is in offline mode: no live network, or the server not
 * answering while the device is online (#1751). A plain-signal service with no
 * HTTP dependency, so anything that only needs to *read* the mode — cover URLs,
 * entity links — can inject it without pulling `HttpClient` into every
 * consumer's tests. `SetupService` owns the probe and is the only writer of
 * `serverUnreachable`; its `isOffline` is this signal.
 */
@Injectable({ providedIn: 'root' })
export class OfflineModeService {
  private readonly network = inject(NetworkStatusService);

  /** The device reports a live network but the server didn't answer. */
  readonly serverUnreachable = signal(false);

  readonly isOffline = computed(() => !this.network.online() || this.serverUnreachable());
}
