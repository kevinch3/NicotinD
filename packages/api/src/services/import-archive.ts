/**
 * Minimal, dependency-free ZIP reading for the library import flow
 * (docs/import.md "Archives as import sources").
 *
 * **Why hand-rolled.** The only pure-JS options either need the whole archive
 * resident in memory (fflate's sync API — impossible for a 20 GB music dump) or
 * pull a dependency for ~200 lines of well-specified header parsing; the only
 * binary options (`unzip`/`bsdtar`/`7z`) would grow every deploy's image and
 * would have to be registered in `scripts/dockerfile-runtime-binaries.test.ts`
 * for a feature most installs never touch. `node:zlib` already ships
 * `createInflateRaw`, which is the whole of DEFLATE.
 *
 * **Central directory first, always.** Every entry is read from the archive's
 * trailing central directory rather than from the per-entry local headers. That
 * is not a style choice: an entry written with a data descriptor (general
 * purpose bit 3 — what a streaming zipper emits) carries *zeroes* for its sizes
 * in the local header, and only the central directory is authoritative. It also
 * means the total uncompressed size is known before a single byte is inflated,
 * which is what keeps the import's disk preflight honest and makes a
 * decompression bomb detectable up front rather than at 400 GB written.
 *
 * Extraction is streamed (a byte range piped through `createInflateRaw`), so
 * peak memory is one pipe buffer regardless of entry size.
 */
import {
  createReadStream,
  createWriteStream,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  rmSync,
} from 'node:fs';
import { createInflateRaw } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, extname, join, sep } from 'node:path';
import type { ImportSourceErrorCode } from '@nicotind/core';
import { isUnderMusicDir } from './song-path.js';

/** Extensions accepted as an archive import source. ZIP only, deliberately. */
export const ARCHIVE_EXTENSIONS = new Set(['.zip']);

/**
 * Ceiling on what one archive may expand to. Generous for a real music dump
 * (a lossless discography), tiny next to what a zip bomb wants.
 */
export const IMPORT_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024 * 1024; // 200 GiB

/**
 * Bomb guard. The threshold sits deliberately far from both ends: real audio
 * zips at ~1:1 (even WAV rarely beats 3:1), while a decompression bomb is
 * 10⁶:1 or worse — so anything in between is left alone rather than guessed at.
 */
export const MAX_COMPRESSION_RATIO = 1000;

/**
 * …and the ratio is only consulted once the declared expansion is big enough to
 * matter. A small archive of silence or blank test files can legitimately have
 * an extreme ratio and is harmless; a bomb is, by construction, enormous.
 */
export const RATIO_CHECK_FLOOR_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Per-entry ceiling, mirroring the addon delivery cap's intent. */
export const MAX_ARCHIVE_ENTRY_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB

export class ArchiveError extends Error {
  constructor(
    public code: Extract<
      ImportSourceErrorCode,
      'ARCHIVE_UNREADABLE' | 'ARCHIVE_ENCRYPTED' | 'ARCHIVE_UNSUPPORTED' | 'ARCHIVE_TOO_LARGE'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ZipEntry {
  /** Entry name exactly as stored (never used as a path — see `safeArchivePath`). */
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate. Anything else is rejected at extraction. */
  method: number;
  /** Byte offset of this entry's LOCAL header. */
  localOffset: number;
  isDirectory: boolean;
  isSymlink: boolean;
  isEncrypted: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The EOCD sits within 64 KiB + 22 of the end (its comment field is 16-bit). */
const MAX_EOCD_SEARCH = 0xffff + 22;
const ZIP64_U32 = 0xffffffff;
const ZIP64_U16 = 0xffff;

/**
 * Read one archive's central directory. Throws `ArchiveError` rather than
 * returning a partial list: a source we cannot fully enumerate must not be
 * imported half-way.
 */
export function readZipCentralDirectory(path: string): ZipEntry[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, MAX_EOCD_SEARCH);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw new ArchiveError('ARCHIVE_UNREADABLE', 'That file is not a readable ZIP archive.');
    }

    const entryCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    // ZIP64 announces itself with sentinel values in the 32/16-bit fields.
    // Reading them literally would seek to a garbage offset, so refuse plainly.
    if (cdOffset === ZIP64_U32 || cdSize === ZIP64_U32 || entryCount === ZIP64_U16) {
      throw new ArchiveError(
        'ARCHIVE_UNSUPPORTED',
        'That ZIP uses the ZIP64 extension, which is not supported — split it into smaller archives.',
      );
    }

    const central = Buffer.alloc(cdSize);
    readSync(fd, central, 0, cdSize, cdOffset);

    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < entryCount; i++) {
      if (p + 46 > central.length || central.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
        throw new ArchiveError(
          'ARCHIVE_UNREADABLE',
          'That ZIP archive is truncated or corrupt (bad central directory).',
        );
      }
      const flags = central.readUInt16LE(p + 8);
      const method = central.readUInt16LE(p + 10);
      const compressedSize = central.readUInt32LE(p + 20);
      const uncompressedSize = central.readUInt32LE(p + 24);
      const nameLen = central.readUInt16LE(p + 28);
      const extraLen = central.readUInt16LE(p + 30);
      const commentLen = central.readUInt16LE(p + 32);
      const externalAttr = central.readUInt32LE(p + 38);
      const localOffset = central.readUInt32LE(p + 42);
      const name = central.toString('utf8', p + 46, p + 46 + nameLen);
      entries.push({
        name,
        compressedSize,
        uncompressedSize,
        method,
        localOffset,
        isDirectory: name.endsWith('/'),
        // Unix mode lives in the high 16 bits of the external attributes; a
        // symlink entry stores its target as the file body, and following one
        // would smuggle a path the folder walk deliberately never follows.
        isSymlink: ((externalAttr >>> 16) & 0o170000) === 0o120000,
        isEncrypted: (flags & 1) !== 0,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/**
 * Reject an archive whose declared expansion is absurd — checked from the
 * central directory, i.e. before anything is written. A zip bomb's whole trick
 * is that its size on disk says nothing about what it becomes.
 */
export function assertArchiveWithinLimits(entries: ZipEntry[]): void {
  let uncompressed = 0;
  let compressed = 0;
  for (const e of entries) {
    if (e.isDirectory || e.isSymlink) continue;
    uncompressed += e.uncompressedSize;
    compressed += e.compressedSize;
  }
  if (uncompressed > IMPORT_MAX_ARCHIVE_BYTES) {
    throw new ArchiveError(
      'ARCHIVE_TOO_LARGE',
      'That archive expands to more than this importer will accept — split it into smaller archives.',
    );
  }
  if (
    uncompressed > RATIO_CHECK_FLOOR_BYTES &&
    compressed > 0 &&
    uncompressed / compressed > MAX_COMPRESSION_RATIO
  ) {
    throw new ArchiveError(
      'ARCHIVE_TOO_LARGE',
      'That archive expands far more than any real music archive would — refusing to extract it.',
    );
  }
}

/**
 * Resolve an archive entry name to a path inside `root`.
 *
 * Deliberately NOT `safeIncomingPath` (the addon-delivery equivalent): that one
 * reduces a filename to its basename, which would flatten `Album/CD1/01.flac`
 * and destroy the per-directory grouping the whole import pipeline is built on.
 * Same discipline, different shape — every segment is validated and the result
 * is asserted to be inside the root before any handle is opened, because a
 * central directory happily stores `../../etc/x`, `/abs/x` and `Album\win.mp3`
 * verbatim.
 */
export function safeArchivePath(root: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/');
  // An absolute (or drive-rooted) entry name is refused rather than quietly
  // re-rooted: no music archive has one, so it signals something built by hand.
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new ArchiveError(
      'ARCHIVE_UNSUPPORTED',
      `Refusing an archive entry with an absolute name: ${entryName}`,
    );
  }
  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..' || s.includes(sep))) {
    throw new ArchiveError(
      'ARCHIVE_UNSUPPORTED',
      `Refusing an archive entry with an unsafe name: ${entryName}`,
    );
  }
  const dest = join(root, ...segments);
  if (!isUnderMusicDir(root, dest)) {
    throw new ArchiveError(
      'ARCHIVE_UNSUPPORTED',
      `Refusing an archive entry that escapes the staging directory: ${entryName}`,
    );
  }
  return dest;
}

/** The entry's path relative to the archive root, posix, safe to join. */
export function archiveEntryRel(entryName: string): string {
  return entryName
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')
    .join('/');
}

/**
 * Stream one entry out of the archive into `dest`. Method 0 (stored) is a plain
 * range copy; method 8 (deflate) pipes that range through `createInflateRaw`.
 * A partial write is always removed — never leave half a track where the
 * organizer can pick it up.
 */
export async function extractZipEntry(
  archivePath: string,
  entry: ZipEntry,
  dest: string,
): Promise<void> {
  if (entry.isEncrypted) {
    throw new ArchiveError(
      'ARCHIVE_ENCRYPTED',
      'That archive is password-protected — extract it yourself and import the folder.',
    );
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ArchiveError(
      'ARCHIVE_UNSUPPORTED',
      `That archive uses an unsupported compression method (${entry.method}).`,
    );
  }
  if (entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) {
    throw new ArchiveError('ARCHIVE_TOO_LARGE', `Archive entry ${entry.name} is too large.`);
  }

  const start = dataOffsetOf(archivePath, entry);
  // A stored entry's compressed length IS its length; guard the empty case so
  // the range read doesn't ask for [start, start-1].
  const end = start + entry.compressedSize - 1;
  let written = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.byteLength;
      if (written > MAX_ARCHIVE_ENTRY_BYTES) {
        cb(new ArchiveError('ARCHIVE_TOO_LARGE', `Archive entry ${entry.name} is too large.`));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    if (entry.compressedSize === 0) {
      await pipeline(emptyStream(), createWriteStream(dest));
      return;
    }
    const source = createReadStream(archivePath, { start, end });
    if (entry.method === 0) {
      await pipeline(source, cap, createWriteStream(dest));
    } else {
      await pipeline(source, createInflateRaw(), cap, createWriteStream(dest));
    }
  } catch (err) {
    rmSync(dest, { force: true });
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError(
      'ARCHIVE_UNREADABLE',
      `Could not extract ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function emptyStream(): NodeJS.ReadableStream {
  const t = new Transform({ transform: (c, _e, cb) => cb(null, c) });
  t.end();
  return t;
}

/**
 * Where an entry's compressed bytes start. Only the LOCAL header knows its own
 * name/extra lengths (they can differ from the central copy), so this one field
 * pair must be read there — everything else still comes from the central
 * directory, which is the half a data descriptor cannot lie about.
 */
function dataOffsetOf(archivePath: string, entry: ZipEntry): number {
  const fd = openSync(archivePath, 'r');
  try {
    const head = Buffer.alloc(30);
    readSync(fd, head, 0, 30, entry.localOffset);
    if (head.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ArchiveError(
        'ARCHIVE_UNREADABLE',
        `That ZIP archive is corrupt (bad local header for ${entry.name}).`,
      );
    }
    return entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  } finally {
    closeSync(fd);
  }
}

/** Is this path an archive we can import? Extension-only; contents decide later. */
export function looksLikeArchive(path: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Display name for an archive source: its filename without the extension. */
export function archiveDisplayName(path: string): string {
  const name = basename(path);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}
