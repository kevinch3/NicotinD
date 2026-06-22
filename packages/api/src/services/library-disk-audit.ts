import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AUDIO_EXTS } from './audio-tags.js';
import type { AuditFinding } from './library-audit.js';

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
}

function isAudio(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && AUDIO_EXTS.has(name.slice(dot).toLowerCase());
}

/** Recursively walk `musicDir`, collecting audio files + truly-empty directories. */
export function scanMusicDir(musicDir: string): DiskScan {
  const audioPaths: string[] = [];
  const emptyDirs: string[] = [];
  const walk = (dir: string): void => {
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
      if (st.isDirectory()) walk(full);
      else if (isAudio(e)) audioPaths.push(relative(musicDir, full));
    }
  };
  walk(musicDir);
  return { audioPaths, emptyDirs };
}

/**
 * Pure: turn a disk scan + the DB's known song paths into findings.
 *   - `missing_file`  (high)   — a `library_songs.path` with no file on disk.
 *   - `orphan_file`   (medium) — an audio file on disk with no DB row.
 *   - `empty_dir`     (low)    — a directory with no entries (leftover folder).
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
  for (const p of onDisk) {
    if (!inDb.has(p)) {
      out.push({
        rule: 'orphan_file',
        severity: 'medium',
        subject: p,
        message: `Audio file "${p}" is on disk but not in the library DB`,
      });
    }
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
