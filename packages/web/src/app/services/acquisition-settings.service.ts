import { Injectable, computed, inject, signal } from '@angular/core';
import { SystemApiService } from './api/system-api.service';

/**
 * The deployment-wide acquisition kill-switch (#235) as seen by the Admin page.
 *
 * why a service rather than component state: this is the one piece of Admin
 * state read by two different sections. The Acquisition & automation panel owns
 * the toggle, and the Library processing panel reads `off()` to explain why
 * hold-for-review is unavailable (#416 — with acquisition off the Downloads page
 * and its review inbox are hidden, so held files would be unreachable). Passing
 * it down as an `input()` is not an option: a signal input on a nested imported
 * component never receives its binding in this repo's JIT vitest harness (see
 * `testing/signal-input.ts`), so the consumer would silently read the default in
 * every page-level spec. Duplicating the fetch instead would mean two
 * `GET /api/admin/acquisition` calls and a stale disabled-state in one panel
 * after the other one writes.
 *
 * Root-provided, so both panels resolve the same instance — the same stance
 * `ServiceReviewService` takes for the snapshot slices.
 */
@Injectable({ providedIn: 'root' })
export class AcquisitionSettingsService {
  private readonly api = inject(SystemApiService);

  readonly state = signal<{ enabled: boolean; configurable: boolean } | null>(null);
  /** Hold-for-review needs a reachable inbox — hidden when acquisition is off (issue #416). */
  readonly off = computed(() => this.state()?.enabled === false);
  readonly saving = signal(false);

  load(): void {
    this.api.getAcquisition().subscribe({
      next: (a) => this.state.set(a),
      // 503 = toggle not wired (an older server); hide the control rather than
      // rendering one that can't work.
      error: () => this.state.set(null),
    });
  }

  set(enabled: boolean): void {
    if (this.saving()) return;
    // Don't call the API when the environment forbids acquisition. `disabled` on
    // the input only stops *user* interaction; the server would refuse anyway,
    // but there is no reason to ask it a question we already know the answer to.
    if (!this.state()?.configurable) return;
    this.saving.set(true);
    this.api.setAcquisition(enabled).subscribe({
      next: (a) => {
        this.state.set(a);
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
  }
}
