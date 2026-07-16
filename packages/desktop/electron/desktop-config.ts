import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { userDataDir } from './paths.js';

/**
 * Desktop-side persisted preferences, distinct from the backend's own
 * `config/default.yml` / env-derived config. The backend takes `musicDir`
 * at **boot** only (`packages/api/src/routes/setup.ts` sets it in-memory,
 * never to disk), so a musicDir chosen in the app would be lost on the next
 * launch unless the *desktop shell* remembers it and re-injects it as
 * `NICOTIND_MUSIC_DIR` on every sidecar start. This module is that memory.
 */
export interface DesktopConfig {
  musicDir?: string;
}

function configFilePath(): string {
  return path.join(userDataDir(), 'desktop-config.json');
}

/**
 * Pure merge of a persisted config with a partial patch — `undefined` values
 * in the patch overwrite (clear) the corresponding key, matching normal
 * object-spread semantics. Factored out so it's unit-testable without
 * touching the filesystem.
 */
export function mergeDesktopConfig(existing: DesktopConfig, patch: Partial<DesktopConfig>): DesktopConfig {
  return { ...existing, ...patch };
}

/**
 * Reads the persisted desktop config. Missing file, unreadable file, or
 * malformed JSON all resolve to `{}` — a corrupt preferences file must never
 * crash app startup, it should just fall back to backend defaults.
 */
export function readDesktopConfig(): DesktopConfig {
  const file = configFilePath();
  if (!existsSync(file)) {
    return {};
  }
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const config: DesktopConfig = {};
    const musicDir = (parsed as Record<string, unknown>).musicDir;
    if (typeof musicDir === 'string') {
      config.musicDir = musicDir;
    }
    return config;
  } catch {
    return {};
  }
}

/**
 * Merges `patch` into the persisted config and writes it back. Creates the
 * userData directory if needed (fresh install).
 */
export function writeDesktopConfig(patch: Partial<DesktopConfig>): void {
  const dir = userDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const merged = mergeDesktopConfig(readDesktopConfig(), patch);
  writeFileSync(configFilePath(), JSON.stringify(merged, null, 2), 'utf-8');
}
