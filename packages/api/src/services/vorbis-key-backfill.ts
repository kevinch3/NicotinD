import { readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { VORBIS_EXTS } from '@nicotind/core';
import { planVorbisKeyHeal, writeAudioTags } from './audio-tags.js';
import { isHiddenFile, isReservedTopLevel } from './library-paths.js';

/**
 * One-off pass that heals spaced Vorbis comment names across the library
 * (#1250, #1231). The same fix runs on every tag write since this shipped; this
 * reaches the files nothing will rewrite on its own.
 *
 * Dry run by default. An applied write is **re-planned from disk** afterwards,
 * so a write that reported success without landing counts as a failure rather
 * than a fix.
 */
export interface VorbisKeyBackfillReport {
  scanned: number;
  /** Files with at least one change to make (dry run) or made (apply). */
  affected: number;
  /** Spaced key → files it was found on. */
  byKey: Record<string, number>;
  /** Left untouched because the canonical twin disagrees — a curation call. */
  conflicts: Array<{ path: string; spaced: string; canonical: string }>;
  /** Applied writes that failed, or that still plan changes when read back. */
  failed: string[];
}

function* libraryFiles(musicDir: string, reserved: ReadonlySet<string>): Generator<string> {
  const stack = [musicDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (dir === musicDir && isReservedTopLevel(e.name, reserved)) continue;
        stack.push(path);
      } else if (!isHiddenFile(e.name) && VORBIS_EXTS.has(extname(e.name).toLowerCase())) {
        yield path;
      }
    }
  }
}

export async function backfillVorbisKeys(opts: {
  musicDir: string;
  reserved: ReadonlySet<string>;
  apply: boolean;
  onProgress?: (scanned: number) => void;
}): Promise<VorbisKeyBackfillReport> {
  const report: VorbisKeyBackfillReport = {
    scanned: 0,
    affected: 0,
    byKey: {},
    conflicts: [],
    failed: [],
  };
  for (const path of libraryFiles(opts.musicDir, opts.reserved)) {
    report.scanned++;
    if (report.scanned % 500 === 0) opts.onProgress?.(report.scanned);
    const plan = await planVorbisKeyHeal(path);
    if (!plan) continue;
    const rel = relative(opts.musicDir, path);
    for (const c of plan.conflicts) report.conflicts.push({ path: rel, ...c });
    const blanked = plan.metadata.filter((m) => m.endsWith('=')).map((m) => m.slice(0, -1));
    if (blanked.length === 0) continue;
    report.affected++;
    for (const k of blanked) report.byKey[k] = (report.byKey[k] ?? 0) + 1;
    if (!opts.apply) continue;
    // An empty write: `writeFfmpegTags` adds the heal to every rewrite.
    const ok = await writeAudioTags(path, {});
    const after = ok ? await planVorbisKeyHeal(path) : null;
    if (!ok || !after || after.metadata.length > 0) report.failed.push(rel);
  }
  return report;
}
