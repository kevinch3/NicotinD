import { Injectable, computed, inject, signal } from '@angular/core';
import { SystemApiService } from './api/system-api.service';

/**
 * The ML vocal-separation opt-in (issue #603) as seen by the Admin page — the
 * `AcquisitionSettingsService` shape: root-provided so the Streaming & media
 * panel (the toggle) and the Library processing panel (the sidecar pill) read
 * one fetch; a 503 (toggle not wired: an older server) hides the control.
 */
@Injectable({ providedIn: 'root' })
export class VocalSeparationSettingsService {
  private readonly api = inject(SystemApiService);

  readonly state = signal<{ enabled: boolean; configurable: boolean } | null>(null);
  readonly off = computed(() => this.state()?.enabled === false);
  readonly saving = signal(false);

  load(): void {
    this.api.getVocalSeparation().subscribe({
      next: (a) => this.state.set(a),
      error: () => this.state.set(null),
    });
  }

  set(enabled: boolean): void {
    if (this.saving()) return;
    // No sidecar URL: the server would refuse anyway, no reason to ask.
    if (!this.state()?.configurable) return;
    this.saving.set(true);
    this.api.setVocalSeparation(enabled).subscribe({
      next: (a) => {
        this.state.set(a);
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
  }
}
