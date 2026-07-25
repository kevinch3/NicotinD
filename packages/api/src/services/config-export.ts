/**
 * Portable, admin-facing **configuration** export/import — issue #221.
 *
 * Distinct from the opaque daily DB snapshot (`backup.ts`, which VACUUMs the
 * *whole* database incl. the reproducible library index): this emits only the
 * small, human-legible *config* a self-hoster would move between installs or
 * hand-edit — the `app_settings` key/value blobs (processing/streaming/download
 * prefs) and the `plugins` table (enabled state + non-secret config + consent).
 *
 * ## Secret handling (deliberate — see issue #221 "Open questions")
 *
 * Plugin credentials (`password`-type config fields per the manifest) and the
 * JWT/service secrets in `secrets.json` are **never** written into the exported
 * artifact. The client downloads a file; a raw API key in a downloaded JSON is
 * an exfiltration hazard we won't ship silently. Redacted field keys are listed
 * per-plugin (`redactedSecrets`) so the import UI can prompt the admin to
 * re-enter them. Import is merge-based (`PluginRegistry.setConfig` unions over
 * existing config), so importing a redacted export onto a host that already has
 * the secret keeps it. Including secrets in the artifact is a documented,
 * deliberately-unimplemented follow-up — see docs/backup-restore.md.
 */
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { PluginRegistry } from './plugins/registry.js';

const log = createLogger('config-export');

/** Bump when the artifact shape changes incompatibly; import rejects unknown versions. */
export const CONFIG_EXPORT_VERSION = 1;
/** Discriminator so a wrong file (e.g. a DB snapshot) is rejected up front. */
export const CONFIG_EXPORT_KIND = 'nicotind-config';

/** One plugin's portable state — secrets redacted (see module doc). */
export interface ExportedPlugin {
  id: string;
  enabled: boolean;
  /** Non-secret config values only (password-type manifest fields removed). */
  config: Record<string, unknown>;
  /** Manifest keys whose (secret) values were stripped from `config`. */
  redactedSecrets: string[];
  consentAt: number | null;
  consentUser: string | null;
}

/** The downloadable config artifact. */
export interface ConfigExport {
  kind: typeof CONFIG_EXPORT_KIND;
  version: number;
  /** Running server version at export time (informational). */
  appVersion: string | null;
  exportedAt: string;
  /** All `app_settings` rows, values parsed from JSON when possible. */
  settings: Record<string, unknown>;
  plugins: ExportedPlugin[];
}

interface PluginRow {
  id: string;
  enabled: number;
  config_json: string | null;
  consent_at: number | null;
  consent_user: string | null;
}

/** Keys of `password`-type config fields for a plugin id, per its manifest. */
function secretKeysFor(registry: PluginRegistry, id: string): Set<string> {
  const fields = registry.get(id)?.manifest.configFields ?? [];
  return new Set(fields.filter((f) => f.type === 'password').map((f) => f.key));
}

/** Parse a stored JSON value; fall back to the raw string when it isn't JSON. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Build the config artifact. Reads `app_settings` verbatim and the `plugins`
 * table, stripping secret (password-type) config fields.
 */
export function exportConfig(
  db: Database,
  registry: PluginRegistry,
  opts: { appVersion?: string | null; now?: number } = {},
): ConfigExport {
  const settings: Record<string, unknown> = {};
  for (const row of db
    .query<{ key: string; value: string }, []>('SELECT key, value FROM app_settings')
    .all()) {
    settings[row.key] = parseValue(row.value);
  }

  const plugins: ExportedPlugin[] = [];
  for (const row of db
    .query<PluginRow, []>(
      'SELECT id, enabled, config_json, consent_at, consent_user FROM plugins ORDER BY id',
    )
    .all()) {
    const secrets = secretKeysFor(registry, row.id);
    const stored = row.config_json ? (parseValue(row.config_json) as Record<string, unknown>) : {};
    const config: Record<string, unknown> = {};
    const redactedSecrets: string[] = [];
    for (const [k, v] of Object.entries(stored ?? {})) {
      if (secrets.has(k)) {
        if (v != null && v !== '') redactedSecrets.push(k);
      } else {
        config[k] = v;
      }
    }
    plugins.push({
      id: row.id,
      enabled: row.enabled === 1,
      config,
      redactedSecrets,
      consentAt: row.consent_at,
      consentUser: row.consent_user,
    });
  }

  return {
    kind: CONFIG_EXPORT_KIND,
    version: CONFIG_EXPORT_VERSION,
    appVersion: opts.appVersion ?? null,
    exportedAt: new Date(opts.now ?? Date.now()).toISOString(),
    settings,
    plugins,
  };
}

/** What a settings key would do on import. */
export interface SettingsChange {
  key: string;
  action: 'create' | 'update' | 'unchanged';
}

/** What a plugin would do on import. */
export interface PluginChange {
  id: string;
  /** True when the plugin id isn't registered on this host (config kept, not applied). */
  unknown: boolean;
  enabledChange: { from: boolean | null; to: boolean } | null;
  /** Non-secret config keys that would be written (merged over existing). */
  configKeys: string[];
  /** Secret keys the source redacted — the admin must re-enter these. */
  redactedSecrets: string[];
}

export interface ImportPlan {
  version: number;
  appVersion: string | null;
  settings: SettingsChange[];
  plugins: PluginChange[];
  warnings: string[];
}

export class ConfigImportError extends Error {}

/** Validate the artifact shape/version, throwing `ConfigImportError` on any problem. */
export function validateConfigArtifact(artifact: unknown): ConfigExport {
  if (!artifact || typeof artifact !== 'object') {
    throw new ConfigImportError('Not a config file');
  }
  const a = artifact as Partial<ConfigExport>;
  if (a.kind !== CONFIG_EXPORT_KIND) {
    throw new ConfigImportError('Not a NicotinD config export (wrong "kind")');
  }
  if (a.version !== CONFIG_EXPORT_VERSION) {
    throw new ConfigImportError(
      `Unsupported config version ${String(a.version)} (this server understands ${CONFIG_EXPORT_VERSION})`,
    );
  }
  if (!a.settings || typeof a.settings !== 'object' || Array.isArray(a.settings)) {
    throw new ConfigImportError('Malformed export: "settings" must be an object');
  }
  if (!Array.isArray(a.plugins)) {
    throw new ConfigImportError('Malformed export: "plugins" must be an array');
  }
  return a as ConfigExport;
}

/** Compute a dry-run "what will change" plan without touching the database. */
export function planConfigImport(
  db: Database,
  registry: PluginRegistry,
  artifact: unknown,
): ImportPlan {
  const parsed = validateConfigArtifact(artifact);
  const warnings: string[] = [];

  const settings: SettingsChange[] = [];
  for (const [key, value] of Object.entries(parsed.settings)) {
    const row = db
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get(key);
    if (!row) {
      settings.push({ key, action: 'create' });
    } else {
      const next = JSON.stringify(value);
      settings.push({ key, action: row.value === next ? 'unchanged' : 'update' });
    }
  }

  const plugins: PluginChange[] = [];
  for (const p of parsed.plugins) {
    const known = registry.get(p.id) !== undefined;
    if (!known) warnings.push(`Plugin "${p.id}" is not available on this server — skipped.`);
    const currentRow = db
      .query<{ enabled: number }, [string]>('SELECT enabled FROM plugins WHERE id = ?')
      .get(p.id);
    const currentEnabled = currentRow ? currentRow.enabled === 1 : null;
    const configKeys = Object.keys(p.config ?? {});
    plugins.push({
      id: p.id,
      unknown: !known,
      enabledChange: currentEnabled === p.enabled ? null : { from: currentEnabled, to: p.enabled },
      configKeys: known ? configKeys : [],
      redactedSecrets: p.redactedSecrets ?? [],
    });
    if (known && (p.redactedSecrets?.length ?? 0) > 0 && p.enabled) {
      warnings.push(
        `Plugin "${p.id}" has ${p.redactedSecrets.length} secret(s) not in the export — re-enter them in Extensions.`,
      );
    }
  }

  return {
    version: parsed.version,
    appVersion: parsed.appVersion ?? null,
    settings,
    plugins,
    warnings,
  };
}

export interface ImportResult {
  settingsWritten: number;
  pluginsConfigured: number;
  pluginsEnabledChanged: number;
  warnings: string[];
}

/**
 * Apply the artifact: upsert `app_settings`, then merge each known plugin's
 * non-secret config (`setConfig`, which unions over existing so a redacted
 * secret already on this host is preserved) and reconcile its enabled state.
 * Unknown plugins are skipped (warned). Idempotent: re-importing the same
 * artifact writes the same values.
 */
export async function applyConfigImport(
  db: Database,
  registry: PluginRegistry,
  artifact: unknown,
  opts: { consentUser: string },
): Promise<ImportResult> {
  const plan = planConfigImport(db, registry, artifact);
  const parsed = validateConfigArtifact(artifact);

  let settingsWritten = 0;
  for (const [key, value] of Object.entries(parsed.settings)) {
    db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, JSON.stringify(value)],
    );
    settingsWritten++;
  }

  let pluginsConfigured = 0;
  let pluginsEnabledChanged = 0;
  for (const p of parsed.plugins) {
    if (registry.get(p.id) === undefined) continue; // unknown → skip (warned in plan)
    try {
      if (Object.keys(p.config ?? {}).length > 0) {
        registry.setConfig(p.id, p.config);
        pluginsConfigured++;
      }
      const currentEnabled = registry.isEnabled(p.id);
      if (p.enabled && !currentEnabled) {
        await registry.enable(p.id, opts.consentUser);
        pluginsEnabledChanged++;
      } else if (!p.enabled && currentEnabled) {
        await registry.disable(p.id);
        pluginsEnabledChanged++;
      }
    } catch (err) {
      log.warn({ id: p.id, err }, 'config import: plugin apply failed');
      plan.warnings.push(
        `Plugin "${p.id}" import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await registry.flushReinit();
  log.info({ settingsWritten, pluginsConfigured, pluginsEnabledChanged }, 'config import applied');
  return { settingsWritten, pluginsConfigured, pluginsEnabledChanged, warnings: plan.warnings };
}
