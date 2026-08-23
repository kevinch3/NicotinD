import { Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { AcquisitionSettingsService } from '../../../services/acquisition-settings.service';
import { SystemApiService } from '../../../services/api/system-api.service';
import type { AutoPlaylistCadence, AutoPlaylistStatus } from '../../../services/api/api-types';
import { TranslateService } from '../../../services/translate.service';

/**
 * Admin card for the deployment-wide acquisition kill-switch (#235) and the
 * automated-playlist cadence (docs/automated-playlists.md).
 *
 * The kill-switch lives on the root `AcquisitionSettingsService` rather than in
 * this class because the Library processing panel reads it too — see that
 * service for why an `input()` cannot carry it in this repo's test harness.
 */
@Component({
  selector: 'app-acquisition-automation-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, TranslatePipe],
  templateUrl: './acquisition-automation-panel.component.html',
})
export class AcquisitionAutomationPanelComponent implements OnInit {
  private readonly api = inject(SystemApiService);
  private readonly i18n = inject(TranslateService);
  protected readonly acqSvc = inject(AcquisitionSettingsService);

  readonly autoPlaylists = signal<AutoPlaylistStatus | null>(null);
  readonly autoPlaylistsBusy = signal(false);
  readonly autoPlaylistsMsg = signal<string | null>(null);

  ngOnInit(): void {
    this.acqSvc.load();
    void this.loadAutoPlaylists();
  }

  private async loadAutoPlaylists(): Promise<void> {
    try {
      this.autoPlaylists.set(await firstValueFrom(this.api.getAutoPlaylists()));
    } catch {
      // Non-fatal — the control just won't render until a reload succeeds.
    }
  }

  async setAutoPlaylistCadence(cadence: AutoPlaylistCadence): Promise<void> {
    this.autoPlaylistsMsg.set(null);
    try {
      this.autoPlaylists.set(await firstValueFrom(this.api.setAutoPlaylistCadence(cadence)));
    } catch {
      this.autoPlaylistsMsg.set(this.i18n.t('admin.cadenceSaveFailed'));
    }
  }

  async refreshAutoPlaylists(): Promise<void> {
    if (this.autoPlaylistsBusy()) return;
    this.autoPlaylistsBusy.set(true);
    this.autoPlaylistsMsg.set(null);
    try {
      const res = await firstValueFrom(this.api.refreshAutoPlaylists());
      const made = res.shelves.filter((s) => s.count > 0).length;
      this.autoPlaylists.set({ cadence: res.cadence, lastRefreshedAt: res.lastRefreshedAt });
      this.autoPlaylistsMsg.set(
        this.i18n.t(
          made === 1 ? 'admin.regeneratedShelfSingular' : 'admin.regeneratedShelfPlural',
          {
            count: made,
          },
        ),
      );
    } catch {
      this.autoPlaylistsMsg.set(this.i18n.t('admin.refreshFailed'));
    } finally {
      this.autoPlaylistsBusy.set(false);
    }
  }

  formatRefreshedAt(ms: number | null): string {
    return ms ? new Date(ms).toLocaleString() : this.i18n.t('admin.never');
  }
}
