import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import { HistoryApiService } from '../../../services/api/history-api.service';
import { ConfirmService } from '../../../services/confirm.service';
import { ListeningQueueService } from '../../../services/listening-queue.service';
import { ToastService } from '../../../services/toast.service';
import { TranslateService } from '../../../services/translate.service';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import type { PrivacyState } from '../../../services/api/api-types';

/**
 * Settings → Privacy (issue #454): what this instance stores about you, and the
 * three things you can do about it — stop collection, take a copy, delete it.
 *
 * Transparency is the point of the page, so it states what is stored and who
 * can see it in plain language rather than linking to a doc. The three controls
 * below it are the GDPR rights those sentences imply.
 */
@Component({
  selector: 'app-privacy-settings',
  imports: [
    RouterLink,
    SettingsGroupComponent,
    TvNavGroupDirective,
    TvNavItemDirective,
    TranslatePipe,
  ],
  templateUrl: './privacy.component.html',
})
export class PrivacySettingsComponent implements OnInit {
  private api = inject(HistoryApiService);
  private confirm = inject(ConfirmService);
  private queue = inject(ListeningQueueService);
  private toast = inject(ToastService);
  private i18n = inject(TranslateService);

  readonly state = signal<PrivacyState | null>(null);
  readonly busy = signal(false);

  /** True only when the *user* is the one who turned it off — the only case
   *  where flipping the toggle actually changes anything. */
  readonly toggleUsable = computed(() => {
    const blocked = this.state()?.collection.blockedBy;
    return blocked === null || blocked === 'user';
  });

  /** Why collection is off, when it isn't the user's own choice. */
  readonly lockedReason = computed(() => {
    const blocked = this.state()?.collection.blockedBy;
    if (blocked === 'env') return 'privacy.lockedEnv';
    if (blocked === 'instance') return 'privacy.lockedInstance';
    return null;
  });

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const res = await firstValueFrom(this.api.getPrivacy().pipe(catchError(() => of(null))));
    this.state.set(res);
  }

  async toggleHistory(): Promise<void> {
    const current = this.state();
    if (!current || this.busy()) return;
    this.busy.set(true);
    try {
      const next = await firstValueFrom(this.api.setHistoryConsent(!current.historyEnabled));
      this.state.set(next);
      // Reporting stops itself after a refusal; turning it back on must resume
      // immediately rather than waiting for a reload.
      if (next.collection.enabled) this.queue.resetConsentState();
    } catch {
      this.toast.show({ message: this.i18n.t('privacy.saveFailed'), kind: 'error' });
    } finally {
      this.busy.set(false);
    }
  }

  /** Download the export as a file rather than rendering a wall of JSON. */
  async exportData(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const bundle = await firstValueFrom(this.api.exportMyData());
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nicotind-my-data.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      this.toast.show({ message: this.i18n.t('privacy.exportFailed'), kind: 'error' });
    } finally {
      this.busy.set(false);
    }
  }

  /** Erasure is irreversible, so it goes through the global confirm host. */
  async deleteHistory(): Promise<void> {
    if (this.busy()) return;
    const ok = await this.confirm.ask(this.i18n.t('privacy.deleteMessage'));
    if (!ok) return;

    this.busy.set(true);
    try {
      const { deleted } = await firstValueFrom(this.api.deleteMyHistory());
      this.toast.show({
        message: this.i18n.t('privacy.deleted', { count: deleted }),
        kind: 'success',
      });
      await this.load();
    } catch {
      this.toast.show({ message: this.i18n.t('privacy.deleteFailed'), kind: 'error' });
    } finally {
      this.busy.set(false);
    }
  }
}
