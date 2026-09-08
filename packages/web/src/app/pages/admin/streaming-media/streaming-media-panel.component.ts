import { Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { SystemApiService } from '../../../services/api/system-api.service';
import type { StreamingSettings } from '../../../services/api/api-types';
import { TranslateService } from '../../../services/translate.service';

/** Admin card for the streaming/transcode settings (docs/library-scanner.md). */
@Component({
  selector: 'app-streaming-media-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './streaming-media-panel.component.html',
})
export class StreamingMediaPanelComponent implements OnInit {
  private readonly api = inject(SystemApiService);
  private readonly i18n = inject(TranslateService);

  readonly streaming = signal<StreamingSettings | null>(null);
  readonly streamingSaving = signal(false);
  readonly streamingMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  ngOnInit(): void {
    void this.loadStreaming();
  }

  private async loadStreaming(): Promise<void> {
    try {
      this.streaming.set(await firstValueFrom(this.api.getStreamingSettings()));
    } catch {
      /* ignore */
    }
  }

  async saveStreaming(patch: Partial<StreamingSettings>): Promise<void> {
    this.streamingSaving.set(true);
    this.streamingMessage.set(null);
    try {
      this.streaming.set(await firstValueFrom(this.api.saveStreamingSettings(patch)));
      this.streamingMessage.set({ type: 'success', text: this.i18n.t('admin.streamingSaved') });
    } catch {
      this.streamingMessage.set({ type: 'error', text: this.i18n.t('admin.streamingSaveFailed') });
    } finally {
      this.streamingSaving.set(false);
    }
  }
}
