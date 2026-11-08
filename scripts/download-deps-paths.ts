import { join } from 'node:path';

/**
 * Where the first-run downloader installs: `<dataDir>/bin`, the same place boot
 * looks for the Lidarr binary. Boot passes its resolved data dir in
 * NICOTIND_DATA_DIR; run by hand, the env var or the ~/.nicotind default applies.
 */
export function depsDataDir(env: Record<string, string | undefined>): string {
  const home = env.HOME ?? '/root';
  const dir = env.NICOTIND_DATA_DIR || '~/.nicotind';
  return dir.startsWith('~') ? join(home, dir.slice(1)) : dir;
}
