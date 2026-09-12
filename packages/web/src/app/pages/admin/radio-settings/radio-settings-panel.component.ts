import { Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { SystemApiService } from '../../../services/api/system-api.service';
import type { RadioSettings } from '../../../services/api/api-types';
import { TranslateService } from '../../../services/translate.service';

/**
 * Admin card for radio preferences — today the one opt-in: the learned genre
 * axis (docs/genre-affinity.md). Same shape as the streaming panel: load on
 * init, save a patch per control, echo the server's answer back into the
 * signal so the status line (how many genre profiles exist) stays honest.
 */
@Component({
  selector: 'app-radio-settings-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './radio-settings-panel.component.html',
})
export class RadioSettingsPanelComponent implements OnInit {
  private readonly api = inject(SystemApiService);
  private readonly i18n = inject(TranslateService);

  readonly radio = signal<RadioSettings | null>(null);
  readonly saving = signal(false);
  readonly message = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.radio.set(await firstValueFrom(this.api.getRadioSettings()));
    } catch {
      /* ignore — the card simply stays empty */
    }
  }

  async save(patch: Partial<Pick<RadioSettings, 'genreAffinity'>>): Promise<void> {
    this.saving.set(true);
    this.message.set(null);
    try {
      this.radio.set(await firstValueFrom(this.api.saveRadioSettings(patch)));
      this.message.set({ type: 'success', text: this.i18n.t('admin.radioSaved') });
    } catch {
      this.message.set({ type: 'error', text: this.i18n.t('admin.radioSaveFailed') });
    } finally {
      this.saving.set(false);
    }
  }
}
