/**
 * Pure source-folder scanning for the admin import flow (docs/import.md):
 * validate a candidate path, walk it into per-directory audio groups, and pack
 * those groups into bounded chunks. No DB, no staging — the I/O half lives in
 * `library-import.service.ts`.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { ImportSourceErrorCode } from '@nicotind/core';
import { AUDIO_EXTENSIONS } from './plugins/acquire/process.js';
import { expandDir, isUnderMusicDir } from './song-path.js';

/** Walk caps: past these the preview reports `truncated` and submit refuses. */
export const IMPORT_MAX_FILES = 100_000;
export const IMPORT_MAX_DEPTH = 16;

export interface ImportScanLimits {
  maxFiles?: number;
  maxDepth?: number;
}

export interface ImportScanFile {
  /** Path relative to the scan root, posix separators. */
  rel: string;
  size: number;
}

/** One source directory containing at least one audio file. */
export interface ImportScanDir {
  /** Directory relative to the scan root, posix separators; `'.'` for the root itself. */
  dir: string;
  files: ImportScanFile[];
  bytes: number;
}

export interface ImportScanResult {
  dirs: ImportScanDir[];
  files: number;
  bytes: number;
  unsupportedFiles: number;
  skippedSymlinks: number;
  truncated: boolean;
}

export type ValidateImportSourceResult =
  { ok: true; realPath: string } | { ok: false; code: ImportSourceErrorCode };

/**
 * Validate a candidate import source path. Realpaths both sides so a symlink
 * can't disguise the music dir (or data dir) as an innocent-looking source.
 * Containment is checked in BOTH directions: importing from inside the library
 * would feed the organizer its own output, and importing a folder that
 * *contains* the library (e.g. `/`) would re-ingest the whole library plus the
 * data dir. Equality counts as "inside".
 */
export function validateImportSource(
  rawPath: string,
  musicDir: string,
  dataDir: string,
): ValidateImportSourceResult {
  let real: string;
  try {
    real = realpathSync(expandDir(rawPath.trim()));
  } catch {
    return { ok: false, code: 'NOT_FOUND' };
  }
  if (!statSync(real).isDirectory()) return { ok: false, code: 'NOT_DIR' };
  const musicReal = safeRealpath(expandDir(musicDir));
  const dataReal = safeRealpath(expandDir(dataDir));
  if (real === musicReal || isUnderMusicDir(musicReal, real)) {
    return { ok: false, code: 'INSIDE_LIBRARY' };
  }
  if (isUnderMusicDir(real, musicReal)) return { ok: false, code: 'CONTAINS_LIBRARY' };
  if (real === dataReal || isUnderMusicDir(dataReal, real)) {
    return { ok: false, code: 'INSIDE_DATA_DIR' };
  }
  if (isUnderMusicDir(real, dataReal)) return { ok: false, code: 'CONTAINS_DATA_DIR' };
  return { ok: true, realPath: real };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(name).toLowerCase());
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * Walk a validated source root into per-directory audio-file groups. Symlinks
 * (file or dir) are never followed — a link could smuggle the library or
 * system files into the walk — only counted. Dot-entries (`.thumbnails`,
 * `@eaDir`-style hidden clutter is left to the unsupported tally, but `.`
 * prefixed names are skipped outright) are never music. Deterministic:
 * directories and files are visited in sorted order so chunk planning and
 * retry resume see the same sequence every run.
 */
export function scanImportSource(root: string, limits: ImportScanLimits = {}): ImportScanResult {
  const maxFiles = limits.maxFiles ?? IMPORT_MAX_FILES;
  const maxDepth = limits.maxDepth ?? IMPORT_MAX_DEPTH;
  const byDir = new Map<string, ImportScanFile[]>();
  const result = {
    files: 0,
    bytes: 0,
    unsupportedFiles: 0,
    skippedSymlinks: 0,
    truncated: false,
  };

  const walk = (dir: string, depth: number): void => {
    if (result.truncated) return;
    if (depth > maxDepth) {
      result.truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subdir: skip rather than fail the whole walk
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.truncated) return;
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      // Dirent.isSymbolicLink() covers the common case; lstat re-checks for
      // filesystems whose readdir doesn't report types (entry.isFile() false).
      if (entry.isSymbolicLink()) {
        result.skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        try {
          const st = lstatSync(abs);
          if (st.isSymbolicLink()) {
            result.skippedSymlinks += 1;
            continue;
          }
          if (!st.isFile()) continue;
        } catch {
          continue;
        }
      }
      if (!isAudioFile(entry.name)) {
        result.unsupportedFiles += 1;
        continue;
      }
      if (result.files >= maxFiles) {
        result.truncated = true;
        return;
      }
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue; // vanished mid-walk
      }
      const relDir = toPosix(relative(root, dir)) || '.';
      let list = byDir.get(relDir);
      if (!list) {
        list = [];
        byDir.set(relDir, list);
      }
      list.push({ rel: toPosix(relative(root, abs)), size });
      result.files += 1;
      result.bytes += size;
    }
  };

  walk(root, 0);
  const dirs: ImportScanDir[] = [...byDir.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, files]) => ({ dir, files, bytes: files.reduce((n, f) => n + f.size, 0) }));
  return { dirs, ...result };
}

export interface ImportChunk {
  dirs: ImportScanDir[];
  files: number;
  bytes: number;
}

/**
 * Pack scan dirs into chunks of roughly `targetFiles` files. A directory is
 * NEVER split across chunks — the organizer's folder-tag derivation and
 * compilation detection need the whole album group in one batch — so an
 * oversized directory becomes its own (over-target) chunk. Preserves the
 * scanner's sorted order.
 */
export function planImportChunks(dirs: ImportScanDir[], targetFiles = 200): ImportChunk[] {
  const chunks: ImportChunk[] = [];
  let current: ImportScanDir[] = [];
  let count = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      dirs: current,
      files: count,
      bytes: current.reduce((n, d) => n + d.bytes, 0),
    });
    current = [];
    count = 0;
  };
  for (const dir of dirs) {
    if (count > 0 && count + dir.files.length > targetFiles) flush();
    current.push(dir);
    count += dir.files.length;
    if (count >= targetFiles) flush();
  }
  flush();
  return chunks;
}
