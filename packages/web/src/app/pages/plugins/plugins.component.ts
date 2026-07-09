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

/**
 * Plugins that own a dedicated settings surface (bespoke UI beyond the generic
 * `configFields` form) map their id → detail route here. The card renders a
 * "Configure →" link when an entry exists. Keeps the extension-specific UI with
 * the extension instead of leaking it into this generic list.
 */
const PLUGIN_DETAIL_ROUTES: Record<string, string> = {
  slskd: '/settings/plugins/slskd',
};

@Component({
  selector: 'app-plugins',
  standalone: true,
  imports: [RouterLink, NgTemplateOutlet, FormsModule, ConfirmDialogComponent],
  templateUrl: './plugins.component.html',
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

  /** Dedicated settings route for a plugin, or null when it uses the inline form only. */
  detailRoute(pluginId: string): string | null {
    return PLUGIN_DETAIL_ROUTES[pluginId] ?? null;
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
