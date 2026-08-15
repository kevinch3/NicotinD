import { Component, inject, signal, effect, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { AuthService } from '../../services/auth.service';
import { PluginService, type PluginInfo } from '../../services/plugin.service';
import { capabilityRiskLine } from '@nicotind/core';
import { buildPluginConfigPayload, initialPluginConfigValues } from '../../lib/plugin-config';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { PluginCardComponent } from './plugin-card.component';
import { AddonCatalogCardComponent } from './addon-catalog-card.component';
import { AddonCatalogService } from '../../services/addon-catalog.service';
import { SettingsGroupComponent } from '../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

/**
 * Admin-only plugin management. Lists plugins grouped by kind (acquisition now;
 * connectivity is rendered generically so a tailscale/wireguard plugin can later
 * drop in with no UI changes). Enabling a consent-gated plugin shows its legal
 * disclaimer and requires explicit acknowledgement.
 *
 * Task 4 (settings-cards unification): the three kind sections are collapsible
 * `<app-settings-group>` cards (groupIds `plugins-acquisition`/`plugins-metadata`/
 * `plugins-connectivity`), and there is no more per-plugin detail route.
 */

@Component({
  selector: 'app-plugins',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    ConfirmDialogComponent,
    TvNavGroupDirective,
    TvNavItemDirective,
    PluginCardComponent,
    AddonCatalogCardComponent,
    SettingsGroupComponent,
    TranslatePipe,
  ],
  templateUrl: './plugins.component.html',
})
export class PluginsComponent implements OnInit {
  readonly plugins = inject(PluginService);
  readonly catalog = inject(AddonCatalogService);
  readonly isAdmin = inject(AuthService).isAdmin;
  private readonly i18n = inject(TranslateService);
  /**
   * Deployment-wide acquisition kill-switch (issue #235). When off, every
   * acquisition route hard-404s and the pollers never start — so listing
   * acquisition extensions here offers a switch that cannot do anything, and
   * the page's "nothing is downloaded until you enable an extension" framing
   * is actively wrong. Read from the server (`/api/auth/me`), not the role.
   */
  readonly acquisitionEnabled = inject(AuthService).serverAcquisitionEnabled;
  readonly busy = signal(false);
  readonly message = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  readonly consentTarget = signal<PluginInfo | null>(null);
  /** Remote addon pending removal (confirm dialog). */
  readonly removeTarget = signal<PluginInfo | null>(null);
  readonly addonUrl = signal('');
  readonly addonToken = signal('');
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
    // The marketplace section is admin-only; only fetch the catalog for admins.
    if (this.isAdmin()) void this.catalog.refresh();
  }

  /** This plugin's editable config values (empty when it has no config form).
   *  A method, not an inline `configDraft()[id] ?? {}` in the template: the
   *  index signature's type hides the `undefined` a missing key really returns,
   *  so the `??` reads as removable to `ngc` (NG8102) while being load-bearing
   *  at runtime. */
  draftFor(pluginId: string): Record<string, string> {
    return this.configDraft()[pluginId] ?? {};
  }

  setField(pluginId: string, key: string, value: string): void {
    this.configDraft.update((d) => ({ ...d, [pluginId]: { ...d[pluginId], [key]: value } }));
  }

  saveConfig(p: PluginInfo): void {
    const fields = p.configFields ?? [];
    const payload = buildPluginConfigPayload(fields, this.configDraft()[p.id] ?? {});
    void this.run(
      () => this.plugins.saveConfig(p.id, payload),
      this.i18n.t('extensions.settingsSaved', { name: p.name }),
    );
  }

  toggle(p: PluginInfo): void {
    if (p.enabled) {
      void this.run(
        () => this.plugins.disable(p.id),
        this.i18n.t('extensions.pluginDisabled', { name: p.name }),
      );
    } else if (p.compliance?.requiresConsent) {
      this.consentTarget.set(p);
    } else {
      void this.run(
        () => this.plugins.enable(p.id),
        this.i18n.t('extensions.pluginEnabled', { name: p.name }),
      );
    }
  }

  addAddon(): void {
    const url = this.addonUrl().trim();
    const token = this.addonToken().trim();
    if (!url || !token) return;
    void this.run(async () => {
      await this.plugins.addAddon(url, token);
      this.addonUrl.set('');
      this.addonToken.set('');
    }, this.i18n.t('extensions.addonAdded'));
  }

  confirmRemoveAddon(): void {
    const p = this.removeTarget();
    if (!p) return;
    this.removeTarget.set(null);
    void this.run(
      () => this.plugins.removeAddon(p.id),
      this.i18n.t('extensions.addonRemoved', { name: p.name }),
    );
  }

  /**
   * Plain-language risk lines for the consent dialog of a remote addon (§3) —
   * one per declared capability, so the admin sees what enabling an untrusted
   * addon actually lets it do (e.g. "download" → writes files into your library).
   */
  consentRisks(p: PluginInfo): string[] {
    return p.capabilities.map((c) => capabilityRiskLine(c));
  }

  confirmConsent(): void {
    const p = this.consentTarget();
    if (!p) return;
    this.consentTarget.set(null);
    void this.run(
      () => this.plugins.enable(p.id, true),
      this.i18n.t('extensions.pluginEnabled', { name: p.name }),
    );
  }

  private async run(op: () => Promise<void>, ok: string): Promise<void> {
    this.busy.set(true);
    this.message.set(null);
    try {
      await op();
      this.message.set({ type: 'success', text: ok });
    } catch (err) {
      const text = err instanceof Error ? err.message : this.i18n.t('extensions.operationFailed');
      this.message.set({ type: 'error', text });
    } finally {
      this.busy.set(false);
    }
  }
}
