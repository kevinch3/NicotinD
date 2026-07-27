import { join } from 'node:path';

/**
 * Expand a leading `~` to the user's home directory, leaving any other path
 * untouched.
 *
 * why this exists as a module: the same four-line helper was copy-pasted into
 * **30** dev/maintenance scripts, and one copy had drifted to
 *
 *     return p.startsWith('~') ? join(HOME, p.slice(1)) : '';
 *                                                         ^^ should be `p`
 *
 * returning an **empty string for every absolute path**. That copy was in
 * `check-fragments.ts`, which CLAUDE.md documents as a CLI gate — so the gate
 * had never once run in a Docker deployment: `NICOTIND_DATA_DIR=/data/nicotind`
 * collapsed to `''` and the script exited with
 * `Database not found at nicotind.db`.
 *
 * It survived because local development uses the default `~/.nicotind`, which
 * takes the `~` branch and works. The bug was only reachable with an absolute
 * path — i.e. only in production.
 */
export function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}
