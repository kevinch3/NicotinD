import { Component, inject, signal, effect, OnInit } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { PluginService, type PluginInfo } from '../../services/plugin.service';
import { buildPluginConfigPayload, initialPluginConfigValues } from '../../lib/plugin-config';

/**
 * Admin-only plugin management. Lists plugins grouped by kind (acquisition now;
 * connectivity is rendered generically so a tailscale/wireguard plugin can later
 * drop in with no UI changes). Enabling a consent-gated plugin shows its legal
 * disclaimer and requires explicit acknowledgement.
 */
@Component({
  selector: 'app-plugins',
  standalone: true,
  imports: [RouterLink, NgTemplateOutlet, FormsModule, ConfirmDialogComponent],
  template: `
    <div class="max-w-3xl mx-auto px-4 py-8">
      <div class="flex items-center gap-3 mb-1">
        <a routerLink="/settings" class="text-theme-muted hover:text-theme-secondary text-sm">← Settings</a>
      </div>
      <h1 class="text-2xl font-bold text-theme-primary mb-1">Plugins</h1>
      <p class="text-sm text-theme-muted mb-8">
        Acquisition is opt-in. Nothing is downloaded until you enable a plugin here — you are
        responsible for ensuring its use is lawful where you are.
      </p>

      @if (message()) {
        <div
          class="mb-4 px-4 py-2.5 rounded-xl text-sm"
          [class]="
            message()!.type === 'error'
              ? 'status-error'
              : 'status-done'
          "
        >
          {{ message()!.text }}
        </div>
      }

      <section class="mb-10">
        <h2 class="text-sm font-semibold text-theme-secondary uppercase tracking-wider mb-3">
          Acquisition
        </h2>
        @for (p of plugins.acquisition(); track p.id) {
          <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ $implicit: p }" />
        }
        @if (plugins.acquisition().length === 0) {
          <p class="text-sm text-theme-muted">No acquisition plugins registered.</p>
        }
      </section>

      <section>
        <h2 class="text-sm font-semibold text-theme-secondary uppercase tracking-wider mb-3">
          Connectivity
        </h2>
        @for (p of plugins.connectivity(); track p.id) {
          <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ $implicit: p }" />
        }
        @if (plugins.connectivity().length === 0) {
          <p class="text-sm text-theme-muted">
            No connectivity plugins yet. Tailscale / WireGuard support will appear here.
          </p>
        }
      </section>

      <ng-template #card let-p>
        <div
          class="mb-3 p-4 rounded-xl bg-theme-surface border border-theme"
          data-testid="plugin-card"
          [attr.data-plugin-id]="p.id"
        >
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-medium text-theme-primary">{{ p.name }}</span>
                @if (p.enabled) {
                  <span
                    class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded status-done"
                    >Enabled</span
                  >
                } @else {
                  <span
                    class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-theme-surface-2 text-theme-muted"
                    >Disabled</span
                  >
                }
                @if (p.enabled && !p.available) {
                  <span
                    class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded status-warn"
                    >Unavailable</span
                  >
                }
              </div>
              <p class="text-sm text-theme-secondary mt-1">{{ p.description }}</p>
              <div class="flex gap-1.5 mt-2 flex-wrap">
                @for (cap of p.capabilities; track cap) {
                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-theme-surface-2 text-theme-secondary">{{
                    cap
                  }}</span>
                }
              </div>
              @if (p.enabled && !p.available && p.requirements?.binaries?.length) {
                <p class="text-xs text-status-warn mt-2">
                  Requires on PATH: {{ p.requirements.binaries.join(', ') }}
                </p>
              }
            </div>
            <button
              (click)="toggle(p)"
              [disabled]="busy()"
              data-testid="plugin-toggle"
              class="shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition disabled:opacity-50"
              [class]="
                p.enabled
                  ? 'bg-theme-surface-2 text-theme-secondary hover:bg-theme-hover'
                  : 'bg-theme-accent text-theme-on-accent hover:opacity-90'
              "
            >
              {{ p.enabled ? 'Disable' : 'Enable' }}
            </button>
          </div>

          @if (p.configFields?.length) {
            <form
              (ngSubmit)="saveConfig(p)"
              class="mt-4 pt-4 border-t border-theme space-y-3"
              data-testid="plugin-config-form"
            >
              @for (f of p.configFields; track f.key) {
                <label class="block">
                  <span class="text-xs text-theme-secondary">
                    {{ f.label }}
                    @if (f.type === 'password' && p.configured?.[f.key]) {
                      <span class="text-status-done">• configured</span>
                    }
                  </span>
                  <input
                    [type]="f.type === 'password' ? 'password' : 'text'"
                    [placeholder]="f.placeholder ?? ''"
                    [ngModel]="draftValue(p.id, f.key)"
                    (ngModelChange)="setField(p.id, f.key, $event)"
                    [name]="p.id + '-' + f.key"
                    [attr.data-testid]="'plugin-config-' + f.key"
                    autocomplete="off"
                    class="mt-1 w-full px-3 py-2 rounded-lg bg-theme-surface border border-theme text-sm text-theme-primary focus:outline-none focus:border-theme-accent"
                  />
                  @if (f.help) {
                    <span class="text-[11px] text-theme-muted mt-1 block">{{ f.help }}</span>
                  }
                </label>
              }
              <button
                type="submit"
                [disabled]="busy()"
                data-testid="plugin-config-save"
                class="px-3 py-1.5 rounded-lg text-sm font-medium bg-theme-surface-2 text-theme-primary hover:bg-theme-hover disabled:opacity-50"
              >
                Save
              </button>
            </form>
          }
        </div>
      </ng-template>
    </div>

    @if (consentTarget(); as p) {
      <app-confirm-dialog
        [message]="p.compliance?.disclaimer ?? 'Enable this plugin?'"
        confirmLabel="I understand — enable"
        (confirm)="confirmConsent()"
        (cancel)="consentTarget.set(null)"
      />
    }
  `,
})
export class PluginsComponent implements OnInit {
  readonly plugins = inject(PluginService);
  readonly busy = signal(false);
  readonly message = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  readonly consentTarget = signal<PluginInfo | null>(null);
  // Per-plugin editable config values (keyed by plugin id → field key). Seeded
  // from each plugin's non-secret `config`; password fields always start blank.
  readonly configDraft = signal<Record<string, Record<string, string>>>({});

  constructor() {
    // Reseed the form drafts whenever the plugin list changes (initial load,
    // after enable/disable, after a save+refresh). Typing doesn't change the
    // list, so in-progress edits aren't clobbered.
    effect(() => {
      const drafts: Record<string, Record<string, string>> = {};
      for (const p of this.plugins.plugins()) {
        if (p.configFields?.length) {
          drafts[p.id] = initialPluginConfigValues(p.configFields, p.config);
        }
      }
      this.configDraft.set(drafts);
    });
  }

  ngOnInit(): void {
    void this.plugins.refresh();
  }

  draftValue(pluginId: string, key: string): string {
    return this.configDraft()[pluginId]?.[key] ?? '';
  }

  setField(pluginId: string, key: string, value: string): void {
    this.configDraft.update((d) => ({ ...d, [pluginId]: { ...d[pluginId], [key]: value } }));
  }

  saveConfig(p: PluginInfo): void {
    const fields = p.configFields ?? [];
    const payload = buildPluginConfigPayload(fields, this.configDraft()[p.id] ?? {});
    void this.run(() => this.plugins.saveConfig(p.id, payload), `${p.name} settings saved`);
  }

  toggle(p: PluginInfo): void {
    if (p.enabled) {
      void this.run(() => this.plugins.disable(p.id), `${p.name} disabled`);
    } else if (p.compliance?.requiresConsent) {
      this.consentTarget.set(p);
    } else {
      void this.run(() => this.plugins.enable(p.id), `${p.name} enabled`);
    }
  }

  confirmConsent(): void {
    const p = this.consentTarget();
    if (!p) return;
    this.consentTarget.set(null);
    void this.run(() => this.plugins.enable(p.id, true), `${p.name} enabled`);
  }

  private async run(op: () => Promise<void>, ok: string): Promise<void> {
    this.busy.set(true);
    this.message.set(null);
    try {
      await op();
      this.message.set({ type: 'success', text: ok });
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Operation failed';
      this.message.set({ type: 'error', text });
    } finally {
      this.busy.set(false);
    }
  }
}
