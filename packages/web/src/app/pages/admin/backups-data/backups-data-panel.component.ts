import { Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { SystemApiService } from '../../../services/api/system-api.service';
import type { ConfigBundle, ImportPlan } from '../../../services/api/api-types';
import { ServiceReviewService } from '../../../services/service-review.service';
import { TranslateService } from '../../../services/translate.service';

/**
 * Admin card for daily backups (docs/backup-restore.md) and the portable config
 * export/import bundle (docs/config-export.md).
 *
 * No `ngOnInit`: the backup list and its summary arrive on the shared
 * `ServiceReview` snapshot, so this panel only ever *writes* and then asks for a
 * refresh (which coalesces with any in-flight one).
 */
@Component({
  selector: 'app-backups-data-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, TranslatePipe],
  templateUrl: './backups-data-panel.component.html',
})
export class BackupsDataPanelComponent {
  private readonly api = inject(SystemApiService);
  private readonly i18n = inject(TranslateService);
  private readonly reviewSvc = inject(ServiceReviewService);

  readonly backups = this.reviewSvc.backups;
  readonly backupsSummary = this.reviewSvc.backupsSummary;

  readonly backingUp = signal(false);
  readonly backupMsg = signal<string | null>(null);

  readonly configBusy = signal(false);
  readonly configMsg = signal<string | null>(null);
  readonly configWithSecrets = signal(false);
  readonly importPlan = signal<ImportPlan | null>(null);
  private pendingBundle: ConfigBundle | null = null;

  async runBackup(): Promise<void> {
    if (this.backingUp()) return;
    this.backingUp.set(true);
    this.backupMsg.set(null);
    try {
      const info = await firstValueFrom(this.api.runBackup());
      this.backupMsg.set(
        this.i18n.t('admin.backupCreated', {
          name: info.name,
          size: this.formatBackupSize(info.sizeBytes),
        }),
      );
      await this.reviewSvc.refresh();
    } catch {
      this.backupMsg.set(this.i18n.t('admin.backupFailed'));
    } finally {
      this.backingUp.set(false);
    }
  }

  async exportConfig(): Promise<void> {
    if (this.configBusy()) return;
    this.configBusy.set(true);
    this.configMsg.set(null);
    try {
      const bundle = await firstValueFrom(this.api.exportConfig(this.configWithSecrets()));
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `nicotind-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.configMsg.set(
        this.i18n.t(
          this.configWithSecrets() ? 'admin.exportedWithCredentials' : 'admin.exportedRedacted',
        ),
      );
    } catch {
      this.configMsg.set(this.i18n.t('admin.exportFailed'));
    } finally {
      this.configBusy.set(false);
    }
  }

  /** Read the picked file and dry-run it; the apply waits for confirmation. */
  async previewImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.configBusy()) return;

    this.configBusy.set(true);
    this.configMsg.set(null);
    this.importPlan.set(null);
    this.pendingBundle = null;
    try {
      const bundle = JSON.parse(await file.text()) as ConfigBundle;
      const res = await firstValueFrom(this.api.importConfig(bundle, true));
      this.importPlan.set(res.plan);
      this.pendingBundle = bundle;
    } catch (err) {
      this.configMsg.set(
        this.i18n.t(err instanceof SyntaxError ? 'admin.invalidJsonFile' : 'admin.bundleRejected'),
      );
    } finally {
      this.configBusy.set(false);
    }
  }

  async applyImport(): Promise<void> {
    const bundle = this.pendingBundle;
    if (!bundle || this.configBusy()) return;
    this.configBusy.set(true);
    try {
      const res = await firstValueFrom(this.api.importConfig(bundle, false));
      const rows = res.plan.sections.reduce((n, s) => n + s.create + s.update, 0);
      this.configMsg.set(this.i18n.t('admin.importedRows', { count: rows }));
      this.importPlan.set(null);
      this.pendingBundle = null;
      await this.reviewSvc.refresh();
    } catch {
      this.configMsg.set(this.i18n.t('admin.importFailed'));
    } finally {
      this.configBusy.set(false);
    }
  }

  cancelImport(): void {
    this.importPlan.set(null);
    this.pendingBundle = null;
  }

  formatBackupSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  formatBackupDate(ms: number): string {
    return new Date(ms).toLocaleString();
  }
}
