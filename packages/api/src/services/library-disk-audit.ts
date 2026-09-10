import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isHiddenFile, isReservedTopLevel, reservedDirsFor } from './library-paths.js';
import type { AuditFinding } from './library-audit.js';
import { AUDIO_EXTENSIONS, fold, foldTitleText } from '@nicotind/core';

/**
 * Disk-side half of the library auditor: walks the music dir once and compares
 * what's on disk against the canonical `library_songs.path` set. Kept separate
 * from the DB rules (`library-audit.ts`) because it does filesystem IO; the
 * walker is split into a pure `diskFindings()` over collected facts so the
 * IO-free part is unit-testable.
 */

export interface DiskScan {
  /** Relative (to musicDir) paths of every audio file found on disk. */
  audioPaths: string[];
  /** Relative paths of directories with no entries at all (safe to rmdir). */
  emptyDirs: string[];
  /** Byte size per audio path, so reclaim/gap findings carry what is at stake. */
  sizes?: ReadonlyMap<string, number>;
}

function isAudio(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** Recursively walk `musicDir`, collecting audio files + truly-empty directories. */
export function scanMusicDir(
  musicDir: string,
  reserved: ReadonlySet<string> = reservedDirsFor(),
): DiskScan {
  const audioPaths: string[] = [];
  const emptyDirs: string[] = [];
  const sizes = new Map<string, number>();
  const walk = (dir: string, isRoot: boolean): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.length === 0) {
      emptyDirs.push(relative(musicDir, dir));
      return;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      // Staging is not library content, so it is neither a finding nor an
      // empty-dir report. → docs/library-path-conventions.md
      if (st.isDirectory()) {
        if (isRoot && isReservedTopLevel(e, reserved)) continue;
        walk(full, false);
      } else if (!isHiddenFile(e) && isAudio(e)) {
        const rel = relative(musicDir, full);
        audioPaths.push(rel);
        sizes.set(rel, st.size);
      }
    }
  };
  walk(musicDir, true);
  return { audioPaths, emptyDirs, sizes };
}

function dirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash < 0 ? '' : relPath.slice(0, slash);
}

/**
 * Folded title from a filename: `NN - Title.ext` / `Artist - Title.ext` / `NN Title.ext`,
 * minus a filesystem-collision suffix (`Title (2)`). A leading number is only
 * stripped when no ` - ` separator already removed the prefix, so `11 - 7 Steps`
 * stays "7steps" rather than colliding with a sibling "Steps" (#1089).
 */
export function fileTitleKey(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[a-z0-9]+$/i, '').replace(/\s*\(\d+\)$/, '');
  const parts = stem.split(/\s+-\s+/);
  const title =
    parts.length > 1 ? (parts[parts.length - 1] ?? stem) : stem.replace(/^\d{1,3}[\s._)-]+/, '');
  return foldTitleText(fold(title)).replace(/\s+/g, '');
}

function sizeLabel(bytes: number | undefined): string {
  return bytes === undefined ? '' : ` (${(bytes / 1e6).toFixed(1)} MB)`;
}

/**
 * Pure: turn a disk scan + the DB's known song paths into findings.
 *   - `missing_file`  (high)   — a `library_songs.path` with no file on disk.
 *   - `orphan_file`   (medium) — an audio file on disk with no DB row, and no
 *                                indexed file in its folder carries its title: an
 *                                indexing gap, never a reclaim candidate.
 *   - `redundant_copy` (low)   — an unindexed file whose folder already serves the
 *                                same title from an indexed, present file (#1079).
 *   - `empty_dir`     (low)    — a directory with no entries (leftover folder).
 * Only a same-folder twin counts: artist folders vary (`Rafaga`/`Ráfaga`), so a
 * cross-folder title match is a hypothesis, not proof of redundancy.
 */
export function diskFindings(scan: DiskScan, dbSongPaths: Iterable<string>): AuditFinding[] {
  const out: AuditFinding[] = [];
  const onDisk = new Set(scan.audioPaths);
  const inDb = new Set(dbSongPaths);
  for (const p of inDb) {
    if (!onDisk.has(p)) {
      out.push({
        rule: 'missing_file',
        severity: 'high',
        subject: p,
        message: `library_songs row points at "${p}" but no file exists on disk`,
      });
    }
  }
  const indexedByDir = new Map<string, Map<string, string>>();
  for (const p of inDb) {
    if (!onDisk.has(p)) continue;
    const key = fileTitleKey(p);
    if (key.length < 3) continue;
    const dir = dirOf(p);
    const titles = indexedByDir.get(dir) ?? new Map<string, string>();
    if (!titles.has(key)) titles.set(key, p);
    indexedByDir.set(dir, titles);
  }
  for (const p of onDisk) {
    if (inDb.has(p)) continue;
    const bytes = scan.sizes?.get(p);
    const key = fileTitleKey(p);
    const twin = key.length >= 3 ? indexedByDir.get(dirOf(p))?.get(key) : undefined;
    out.push(
      twin
        ? {
            rule: 'redundant_copy',
            severity: 'low',
            subject: p,
            bytes,
            message: `Unindexed "${p}"${sizeLabel(bytes)} duplicates indexed "${twin}" in the same folder — reclaim candidate; verify before deleting`,
          }
        : {
            rule: 'orphan_file',
            severity: 'medium',
            subject: p,
            bytes,
            message: `Audio file "${p}"${sizeLabel(bytes)} is on disk but not indexed, and no indexed file in its folder has that title — an indexing gap (rescan), not a reclaim candidate`,
          },
    );
  }
  for (const d of scan.emptyDirs) {
    out.push({
      rule: 'empty_dir',
      severity: 'low',
      subject: d,
      message: `Empty directory "${d}" (leftover folder, should be pruned)`,
    });
  }
  return out;
}
