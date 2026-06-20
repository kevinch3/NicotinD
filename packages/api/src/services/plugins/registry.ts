import type { Database } from 'bun:sqlite';
import {
  createLogger,
  validatePluginManifest,
  type Plugin,
  type PluginInfo,
  type PluginKind,
  type PluginCapability,
} from '@nicotind/core';
import { createPluginHostContext, type HostContextDeps } from './host-context.js';

const log = createLogger('plugin-registry');

interface PluginRow {
  id: string;
  enabled: number;
  config_json: string | null;
  consent_at: number | null;
  consent_user: string | null;
}

export type PluginRegistryOptions = HostContextDeps;

/**
 * Holds first-party plugins (registered at build time), tracks their persisted
 * enable/consent/config state in the `plugins` table, and resolves them by
 * kind/capability for the host orchestrators. Enabling a plugin initializes it
 * with a host context; disabling disposes it. Acquisition plugins are dormant
 * (expose no capability) until explicitly enabled — the compliance posture.
 */
export class PluginRegistry {
  private plugins = new Map<string, Plugin>();
  private initialized = new Set<string>();

  constructor(private opts: PluginRegistryOptions) {}

  /** Register a build-time plugin. Throws on an invalid or duplicate manifest. */
  register(plugin: Plugin): void {
    const errs = validatePluginManifest(plugin.manifest);
    if (errs.length > 0) {
      throw new Error(`invalid plugin manifest for "${plugin.manifest.id}": ${errs.join('; ')}`);
    }
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`plugin "${plugin.manifest.id}" already registered`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  /** Initialize every persisted-enabled plugin. Call once at boot. */
  async initEnabled(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (this.isEnabled(plugin.manifest.id)) await this.initPlugin(plugin);
    }
  }

  private async initPlugin(plugin: Plugin): Promise<void> {
    const id = plugin.manifest.id;
    if (this.initialized.has(id)) return;
    const ctx = createPluginHostContext(id, this.getConfig(id), this.opts);
    try {
      await plugin.init(ctx);
      this.initialized.add(id);
    } catch (err) {
      log.error({ id, err }, 'plugin init failed — leaving it inactive');
    }
  }

  private row(id: string): PluginRow | null {
    return (
      this.opts.db.query<PluginRow, [string]>(`SELECT * FROM plugins WHERE id = ?`).get(id) ?? null
    );
  }

  isEnabled(id: string): boolean {
    return this.row(id)?.enabled === 1;
  }

  getConfig(id: string): Record<string, unknown> {
    const json = this.row(id)?.config_json;
    if (!json) return {};
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Enable + initialize a plugin, recording consent when the manifest requires it. */
  async enable(id: string, consentUser: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`unknown plugin "${id}"`);
    const requiresConsent = plugin.manifest.compliance?.requiresConsent ?? false;
    const now = Math.floor(Date.now() / 1000);
    const consentAt = requiresConsent ? now : null;
    const consentBy = requiresConsent ? consentUser : null;
    this.opts.db.run(
      `INSERT INTO plugins (id, enabled, consent_at, consent_user) VALUES (?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = 1, consent_at = ?, consent_user = ?`,
      [id, consentAt, consentBy, consentAt, consentBy],
    );
    await this.initPlugin(plugin);
  }

  /** Disable + dispose a plugin. Consent + config rows are retained. */
  async disable(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`unknown plugin "${id}"`);
    this.opts.db.run(
      `INSERT INTO plugins (id, enabled) VALUES (?, 0)
       ON CONFLICT(id) DO UPDATE SET enabled = 0`,
      [id],
    );
    if (this.initialized.has(id)) {
      try {
        await plugin.dispose?.();
      } catch (err) {
        log.warn({ id, err }, 'plugin dispose failed');
      }
      this.initialized.delete(id);
    }
  }

  /**
   * Seed a plugin as enabled **only if it has no row yet** (first boot / upgrade).
   * Used for back-compat — e.g. slskd was implicitly active whenever configured
   * before the plugin model existed. An admin's later enable/disable is preserved
   * because the row then exists. Does not initialize; call `initEnabled()` after.
   */
  seedEnabled(id: string, consentUser: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`unknown plugin "${id}"`);
    const requiresConsent = plugin.manifest.compliance?.requiresConsent ?? false;
    const now = Math.floor(Date.now() / 1000);
    this.opts.db.run(
      `INSERT INTO plugins (id, enabled, consent_at, consent_user) VALUES (?, 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [id, requiresConsent ? now : null, requiresConsent ? consentUser : null],
    );
  }

  /** True when at least one enabled plugin provides the given capability. */
  hasCapability(cap: PluginCapability): boolean {
    return this.getEnabledWithCapability(cap).length > 0;
  }

  /**
   * Validate (against the manifest schema) + persist a plugin's config. The new
   * config is **merged over the existing** stored config, so a partial update
   * (e.g. only `clientId`) doesn't wipe other keys — this is what makes the
   * Plugins form's "leave a password blank to keep the current one" UX safe.
   */
  setConfig(id: string, config: Record<string, unknown>): Record<string, unknown> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`unknown plugin "${id}"`);
    const parsed = plugin.manifest.configSchema
      ? (plugin.manifest.configSchema.parse(config) as Record<string, unknown>)
      : config;
    const merged = { ...this.getConfig(id), ...parsed };
    this.opts.db.run(
      `INSERT INTO plugins (id, config_json) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`,
      [id, JSON.stringify(merged)],
    );
    return merged;
  }

  get(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  getAll(): Plugin[] {
    return [...this.plugins.values()];
  }

  /** Enabled plugins (optionally filtered by kind). */
  getEnabled(kind?: PluginKind): Plugin[] {
    return this.getAll().filter(
      (p) => this.isEnabled(p.manifest.id) && (!kind || p.manifest.kind === kind),
    );
  }

  /** Enabled plugins that declare a given capability. */
  getEnabledWithCapability(cap: PluginCapability): Plugin[] {
    return this.getEnabled().filter((p) => p.manifest.capabilities.includes(cap));
  }

  /** First enabled resolve-capable plugin that can handle the URL, if any. */
  getEnabledForUrl(url: string): Plugin | undefined {
    return this.getEnabledWithCapability('resolve').find((p) => p.resolve?.canHandle(url));
  }

  /** Serializable view of all plugins + live state for the UI/API. */
  async list(): Promise<PluginInfo[]> {
    const infos: PluginInfo[] = [];
    for (const p of this.getAll()) {
      const m = p.manifest;
      let available = false;
      try {
        available = await p.isAvailable();
      } catch {
        available = false;
      }
      // Surface config-field state for the admin form, never the raw secrets:
      // `configured[key]` flags whether a value is stored; `config` carries only
      // non-password values for prefill.
      const stored = this.getConfig(m.id);
      let configured: Record<string, boolean> | undefined;
      let config: Record<string, unknown> | undefined;
      if (m.configFields?.length) {
        configured = {};
        config = {};
        for (const f of m.configFields) {
          const value = stored[f.key];
          configured[f.key] = value != null && value !== '';
          if (f.type !== 'password' && value !== undefined) config[f.key] = value;
        }
      }
      infos.push({
        id: m.id,
        name: m.name,
        description: m.description,
        kind: m.kind,
        capabilities: m.capabilities,
        requirements: m.requirements,
        compliance: m.compliance,
        enabled: this.isEnabled(m.id),
        available,
        needsConfig: Boolean(m.configSchema) && !this.row(m.id)?.config_json,
        configFields: m.configFields,
        configured,
        config,
      });
    }
    return infos;
  }
}
