import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger, type PluginHostContext, type PluginStorage } from '@nicotind/core';

export interface HostContextDeps {
  db: Database;
  /** Expanded (no `~`) data dir; staging lives under it. */
  dataDir: string;
  /**
   * Route a plugin's progress report to the right job table. Defaults to a
   * no-op; the host wires this to acquire_jobs/album_jobs updates in later phases.
   */
  emitProgress?: (jobId: string, progress: { done: number; total: number }) => void;
  /** Update the label column for an in-flight job (e.g. playlist title). */
  emitLabel?: (jobId: string, label: string) => void;
}

/**
 * Canonical staging path for a plugin job: `<dataDir>/staging/plugins/<id>/<jobId>`.
 * Shared by the host-context allocator and the host's ingest step so both agree
 * on where a plugin's files land.
 */
export function pluginStagingDir(dataDir: string, pluginId: string, jobId: string): string {
  return join(dataDir, 'staging', 'plugins', pluginId, jobId);
}

/** Plugin-scoped kv backed by the `plugin_kv` table (namespaced by plugin id). */
function createPluginStorage(db: Database, pluginId: string): PluginStorage {
  return {
    get(key) {
      const row = db
        .query<
          { value: string },
          [string, string]
        >(`SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?`)
        .get(pluginId, key);
      return row?.value ?? null;
    },
    set(key, value) {
      db.run(
        `INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
        [pluginId, key, value],
      );
    },
    delete(key) {
      db.run(`DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?`, [pluginId, key]);
    },
  };
}

/**
 * Build the host context handed to a plugin's `init()`. This is the entire
 * surface a plugin may use — staging allocation, progress emission, scoped
 * storage, a logger, and its resolved config. No DB/organizer access.
 */
export function createPluginHostContext(
  pluginId: string,
  config: Record<string, unknown>,
  deps: HostContextDeps,
): PluginHostContext {
  return {
    logger: createLogger(`plugin:${pluginId}`),
    config,
    allocStagingDir(jobId) {
      const dir = pluginStagingDir(deps.dataDir, pluginId, jobId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    emitProgress(jobId, progress) {
      deps.emitProgress?.(jobId, progress);
    },
    emitLabel(jobId, label) {
      deps.emitLabel?.(jobId, label);
    },
    storage: createPluginStorage(deps.db, pluginId),
  };
}
