import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { SystemApiService } from '../../../services/api/system-api.service';
import type {
  LibraryFormatOption,
  LibraryFormatSettings,
  QuarantineDescription,
} from '../../../services/api/api-types';
import { ConfirmService } from '../../../services/confirm.service';
import { TranslateService } from '../../../services/translate.service';

/**
 * Admin card for the library's target format (#1256, #1255).
 *
 * The asymmetry it closes: streaming settings have been editable here since
 * they were written, while the conversion that **rewrites files on disk** was
 * configurable only by editing compose files. The reversible path got the UI.
 *
 * Two things this deliberately does that a plain dropdown would not:
 *
 * 1. **States each format's capabilities beside it.** `canNormalizeLoudness`
 *    comes from the strategy's own `writeGain`, so the UI cannot claim a
 *    capability the encoder does not have. A selector that silently disables
 *    loudness normalization is worse than no selector — the loss has no symptom.
 * 2. **Confirms with a real count before a destructive change.** Switching on a
 *    populated library queues a whole-library re-encode and re-mints every song
 *    id. The API answers 409 until `confirm` is sent, so the number is seen
 *    first rather than a warning nobody reads.
 */
@Component({
  selector: 'app-library-format-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './library-format-panel.component.html',
})
export class LibraryFormatPanelComponent implements OnInit {
  private readonly api = inject(SystemApiService);
  private readonly i18n = inject(TranslateService);
  private readonly confirm = inject(ConfirmService);

  readonly settings = signal<LibraryFormatSettings | null>(null);
  readonly saving = signal(false);
  readonly message = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  /** The format awaiting confirmation, with the count that made it destructive. */
  readonly pending = signal<LibraryFormatOption | null>(null);

  readonly options = computed(() => this.settings()?.available ?? []);

  // Kept originals (#1255). Loaded on request, not with the panel: it walks the
  // quarantine to count files, which an admin page load should not pay for.
  readonly quarantine = signal<QuarantineDescription | null>(null);
  readonly quarantineBusy = signal(false);
  readonly keepRuns = signal(3);
  /** The runs a prune at `keepRuns` would delete — named before anything is. */
  readonly doomedRuns = computed(() => {
    const q = this.quarantine();
    return q ? q.runs.slice(Math.max(1, this.keepRuns())) : [];
  });

  async loadQuarantine(): Promise<void> {
    this.quarantineBusy.set(true);
    try {
      this.quarantine.set(await firstValueFrom(this.api.getQuarantine()));
    } catch {
      this.message.set({ type: 'error', text: this.i18n.t('admin.quarantineLoadFailed') });
    } finally {
      this.quarantineBusy.set(false);
    }
  }

  setKeepRuns(raw: string): void {
    const n = Math.floor(Number(raw));
    this.keepRuns.set(Number.isFinite(n) && n >= 1 ? n : 1);
  }

  /** Delete the named older runs, after the operator has read their names. */
  async pruneQuarantine(): Promise<void> {
    const doomed = this.doomedRuns();
    if (doomed.length === 0) return;
    const names = doomed.map((r) => `${r.name} (${r.files})`).join(', ');
    const ok = await this.confirm.ask(this.i18n.t('admin.quarantinePruneConfirm', { names }));
    if (!ok) return;
    this.quarantineBusy.set(true);
    try {
      await firstValueFrom(this.api.pruneQuarantine(this.keepRuns()));
      // The prune runs as a background pass; it is quick, so re-read shortly.
      await new Promise((r) => setTimeout(r, 1000));
      this.quarantine.set(await firstValueFrom(this.api.getQuarantine()));
      this.message.set({ type: 'success', text: this.i18n.t('admin.quarantinePruned') });
    } catch {
      this.message.set({ type: 'error', text: this.i18n.t('admin.quarantinePruneFailed') });
    } finally {
      this.quarantineBusy.set(false);
    }
  }

  gib(bytes: number): string {
    return (bytes / 1024 ** 3).toFixed(1);
  }

  /** The accepted range, mirroring the API's `TARGET_LUFS_MIN`/`MAX`. */
  readonly lufsMin = -24;
  readonly lufsMax = -9;

  /**
   * Save the loudness target (#1255). Takes effect on the next normalize pass,
   * which re-runs idempotently, so a change is free to make and to undo.
   */
  async saveTarget(raw: string): Promise<void> {
    const value = Number(raw);
    this.message.set(null);
    if (!Number.isFinite(value) || value < this.lufsMin || value > this.lufsMax) {
      this.message.set({ type: 'error', text: this.i18n.t('admin.loudnessTargetInvalid') });
      return;
    }
    if (value === this.settings()?.targetLufs) return;
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.saveLoudnessTarget(value));
      await this.load();
      this.message.set({ type: 'success', text: this.i18n.t('admin.loudnessTargetSaved') });
    } catch {
      this.message.set({ type: 'error', text: this.i18n.t('admin.libraryFormatSaveFailed') });
    } finally {
      this.saving.set(false);
    }
  }

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.settings.set(await firstValueFrom(this.api.getLibraryFormatSettings()));
    } catch {
      /* the card renders empty rather than breaking the page */
    }
  }

  /** Picking a format: applies it outright when free, asks first when not. */
  select(option: LibraryFormatOption): void {
    this.message.set(null);
    if (option.id === this.settings()?.format) return;
    if (option.impact.destructive) {
      this.pending.set(option);
      return;
    }
    void this.apply(option.id, false);
  }

  confirmPending(): void {
    const p = this.pending();
    if (p) void this.apply(p.id, true);
  }

  cancelPending(): void {
    this.pending.set(null);
  }

  private async apply(format: string, confirm: boolean): Promise<void> {
    this.saving.set(true);
    try {
      const next = await firstValueFrom(this.api.saveLibraryFormat(format, confirm));
      // Re-read rather than patching locally: every option's `impact` changes
      // once the target does, and a stale count is the one number here that
      // must not be wrong.
      this.settings.set(next);
      await this.load();
      this.pending.set(null);
      this.message.set({ type: 'success', text: this.i18n.t('admin.libraryFormatSaved') });
    } catch {
      this.message.set({ type: 'error', text: this.i18n.t('admin.libraryFormatSaveFailed') });
    } finally {
      this.saving.set(false);
    }
  }
}
