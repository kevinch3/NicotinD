import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { SystemApiService } from '../../../services/api/system-api.service';
import type { LibraryFormatOption, LibraryFormatSettings } from '../../../services/api/api-types';
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

  readonly settings = signal<LibraryFormatSettings | null>(null);
  readonly saving = signal(false);
  readonly message = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  /** The format awaiting confirmation, with the count that made it destructive. */
  readonly pending = signal<LibraryFormatOption | null>(null);

  readonly options = computed(() => this.settings()?.available ?? []);

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
