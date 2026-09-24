import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { LibraryApiService } from '../../../services/api/library-api.service';
import type { LibraryHealthReport } from '../../../services/api/api-types';
import { ConfirmService } from '../../../services/confirm.service';
import { ServiceReviewService } from '../../../services/service-review.service';
import { TranslateService } from '../../../services/translate.service';
import { isMaintenanceRunning } from '../../../lib/maintenance-progress';
import { buildHealthCards, type HealthCard } from './library-health-cards.lib';

/**
 * Admin card over `GET /api/library/health` (issue #736): one card per report
 * dimension — metrics, the worst-first worklist, the report's remediation hint,
 * and a one-click maintenance pass where one exists for that dimension.
 *
 * Fetched when the group opens and on Refresh, never on page load and never
 * polled: the report issues many point queries (docs/library-audit.md).
 */
@Component({
  selector: 'app-library-health-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, TranslatePipe, RouterLink],
  templateUrl: './library-health-panel.component.html',
})
export class LibraryHealthPanelComponent {
  private readonly api = inject(LibraryApiService);
  private readonly confirm = inject(ConfirmService);
  private readonly reviewSvc = inject(ServiceReviewService);
  private readonly i18n = inject(TranslateService);

  readonly report = signal<LibraryHealthReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly starting = signal(false);
  readonly actionMsg = signal<string | null>(null);

  readonly cards = computed<HealthCard[]>(() => {
    const r = this.report();
    return r ? buildHealthCards(r, (k, p) => this.i18n.t(k, p)) : [];
  });

  /** Any pass blocks the others — they contend for the same DB and disk. */
  readonly actionsDisabled = computed(
    () => this.starting() || isMaintenanceRunning(this.reviewSvc.maintenance()),
  );

  /** Group opened: fetch once. Re-opening keeps the last report; Refresh re-fetches. */
  onOpened(): void {
    if (this.report() === null && !this.loading()) void this.load();
  }

  async load(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      this.report.set(await firstValueFrom(this.api.getLibraryHealth()));
    } catch (err) {
      this.error.set(
        err instanceof Error && err.message ? err.message : this.i18n.t('admin.health.loadFailed'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  formatTime(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  async runAction(card: HealthCard): Promise<void> {
    const action = card.action;
    if (!action || this.actionsDisabled()) return;
    if (action.destructive) {
      const ok = await this.confirm.ask(
        this.i18n.t('admin.health.confirmTranscode', {
          count: this.report()?.dimensions.formatCohesion.metric.losslessSongs ?? 0,
        }),
      );
      if (!ok) return;
    }
    this.starting.set(true);
    this.actionMsg.set(null);
    try {
      await firstValueFrom(this.api.startMaintenance(action.task));
      this.actionMsg.set(this.i18n.t('admin.maintenanceStarted'));
      void this.reviewSvc.refresh();
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.actionMsg.set(
        this.i18n.t(
          status === 409
            ? 'admin.maintenanceBusy'
            : status === 503
              ? 'admin.health.actionUnavailable'
              : 'admin.health.actionFailed',
        ),
      );
    } finally {
      this.starting.set(false);
    }
  }
}
