import { Injectable, inject, signal } from '@angular/core';
import { SystemApiService } from './api/system-api.service';
import type { SetupStatus } from './api/api-types';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SetupService {
  private api = inject(SystemApiService);

  readonly status = signal<SetupStatus | null>(null);
  readonly checked = signal(false);
  readonly isOffline = signal(false);

  async check(): Promise<void> {
    try {
      const status = await firstValueFrom(this.api.getSetupStatus().pipe(timeout(3000)));
      this.status.set(status);
    } catch {
      // API unreachable or timed out — enter offline mode
      this.isOffline.set(true);
    }
    this.checked.set(true);
  }
}
