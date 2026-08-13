import { basename, join } from 'node:path';
import { isUnderMusicDir } from '../song-path.js';
import { AddonContractError } from './client.js';

/**
 * Byte cap on a single file core will pull from an addon
 * (docs/superpowers/specs/2026-08-13-addon-ecosystem-security-contract-foundation-design.md
 * §1 Stream 3). Generous but finite so a hostile/buggy addon cannot exhaust the
 * disk with one item.
 */
export const MAX_ADDON_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * Resolve the staging path for an addon-delivered file, containing it to
 * `<incomingDir>/<addonId>/<jobId>/`. The addon-supplied filename is reduced to
 * its basename (directory components are attacker-controlled and dropped), and
 * every level is asserted to stay inside the staging root — so a `..`/empty
 * basename, or an addonId/jobId that itself tries to traverse, is rejected as a
 * contract violation rather than escaping onto the host.
 */
export function safeIncomingPath(
  incomingDir: string,
  addonId: string,
  jobId: string,
  filename: string,
): string {
  const dir = join(incomingDir, addonId, jobId);
  // addonId / jobId are addon-controlled too: confirm the job dir stays inside.
  if (!isUnderMusicDir(incomingDir, dir)) {
    throw new AddonContractError(`addon/job id escapes the staging root: "${addonId}/${jobId}"`);
  }

  const name = basename(filename.replace(/\\/g, '/'));
  if (!name || name === '.' || name === '..') {
    throw new AddonContractError(`unsafe delivered filename "${filename}"`);
  }

  const local = join(dir, name);
  if (!isUnderMusicDir(dir, local)) {
    throw new AddonContractError(`delivered file path escapes staging: "${filename}"`);
  }
  return local;
}
