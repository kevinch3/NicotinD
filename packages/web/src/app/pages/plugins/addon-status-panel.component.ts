import { Component, Input, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PluginService, type AddonStatus } from '../../services/plugin.service';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Generic live-status panel for a remote addon card (acquisition addon
 * protocol). Renders whatever label/value rows the addon reports — no
 * addon-specific code, which is the whole point: a new addon gets a status
 * panel for free by implementing `GET /addon/v1/status`. Fetched once per
 * card expansion (the `@if`-gated body remounts it), not polled.
 */
@Component({
  selector: 'app-addon-status-panel',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    @if (status(); as s) {
      @if (!s.available) {
        <p class="text-xs text-status-warn" data-testid="addon-status-unreachable">
          {{ 'extensions.addonUnreachable' | t }}
        </p>
      } @else {
        <dl class="space-y-1">
          @for (row of s.rows; track row.key) {
            <div class="flex justify-between text-sm" data-testid="addon-status-row">
              <dt class="text-theme-muted">{{ row.label }}</dt>
              <dd class="text-theme-primary">{{ row.value }}</dd>
            </div>
          }
        </dl>
      }
    }
  `,
})
export class AddonStatusPanelComponent implements OnInit {
  @Input({ required: true }) pluginId!: string;

  private readonly plugins = inject(PluginService);
  readonly status = signal<AddonStatus | null>(null);

  ngOnInit(): void {
    void firstValueFrom(this.plugins.getAddonStatus(this.pluginId))
      .then((s) => this.status.set(s))
      .catch(() => this.status.set({ available: false, rows: [] }));
  }
}
