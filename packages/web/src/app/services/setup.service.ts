import { Injectable, inject, signal } from '@angular/core';
import { ApiService, type SetupStatus } from './api.service';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SetupService {
  private api = inject(ApiService);

  readonly status = signal<SetupStatus | null>(null);
  readonly checked = signal(false);

  async check(): Promise<void> {
    try {
      const status = await firstValueFrom(this.api.getSetupStatus());
      this.status.set(status);
    } catch {
      // API not available — skip setup
    }
    this.checked.set(true);
  }
}
