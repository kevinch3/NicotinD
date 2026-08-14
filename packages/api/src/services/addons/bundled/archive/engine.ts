import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, extname, join } from 'node:path';
import { AUDIO_EXTENSIONS } from '../../../plugins/acquire/process.js';

/**
 * The archive.org resolve engine, host-agnostic (no plugin/addon coupling). It
 * reads an item's `/metadata/<id>` file list, picks one audio format
 * (MP3-preferred), downloads those files into a staging dir, and returns the
 * staged paths + the item's artist/album (archive files carry no embedded tags,
 * so the host needs this meta to file them). Moved out of the in-process archive
 * plugin for the bundled addon; the plugin is deleted once the migration lands.
 */

export const ARCHIVE_URL_PATTERN = '^https?://([a-z0-9-]+\\.)?archive\\.org/';
export const ARCHIVE_DISCLAIMER =
  'archive.org (the Internet Archive) hosts user-uploaded recordings. You are ' +
  'responsible for confirming an item is legitimately distributable and for ' +
  'complying with copyright law in your jurisdiction.';

const META_BASE = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';

interface ArchiveFile {
  name: string;
  format?: string;
  size?: string;
}
interface ArchiveMetadata {
  metadata?: { title?: string; creator?: string | string[]; identifier?: string };
  files?: ArchiveFile[];
}

export interface ResolvedArchiveFile {
  /** Absolute staged path. */
  path: string;
  /** Display title (filename sans extension). */
  title: string;
  /** Basename (survives the organizer's per-album move). */
  filename: string;
  size: number;
}
export interface ResolvedArchive {
  files: ResolvedArchiveFile[];
  artist: string;
  album: string;
}

export interface ArchiveEngineOpts {
  stagingDir: string;
  preferredFormats: string[];
  fetchFn?: typeof fetch;
  downloadFile?: (url: string, dest: string, opts: { signal?: AbortSignal }) => Promise<void>;
  signal?: AbortSignal;
}

/** Make a string safe as a single path segment (no separators, traversal, control chars). */
function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[/\\]/g, '-')
    .replace(/\p{Cc}/gu, '')
    .replace(/^\.+$/, '')
    .trim();
  return cleaned || 'Unknown';
}

function trackTitleFor(fileName: string): string {
  return safeSegment(basename(fileName, extname(fileName)));
}

/** Parse the item identifier from any archive.org item URL. */
export function parseArchiveIdentifier(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'archive.org' && !host.endsWith('.archive.org')) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const known = new Set(['details', 'download', 'compress', 'metadata', 'stream', 'embed']);
  if (parts.length >= 2 && known.has(parts[0]!)) return decodeURIComponent(parts[1]!);
  return null;
}

const isAudio = (f: ArchiveFile): boolean => AUDIO_EXTENSIONS.has(extname(f.name).toLowerCase());

/** Pick the audio files to download: first present preferred format, else the largest single-format group. */
export function selectArchiveFiles(files: ArchiveFile[], preferred: string[]): ArchiveFile[] {
  const audio = files.filter(isAudio);
  if (audio.length === 0) return [];
  for (const token of preferred) {
    const t = token.toLowerCase();
    const matches = audio.filter((f) => (f.format ?? '').toLowerCase().includes(t));
    if (matches.length > 0) return matches;
  }
  const byFormat = new Map<string, ArchiveFile[]>();
  for (const f of audio) {
    const key = f.format ?? extname(f.name).toLowerCase();
    const group = byFormat.get(key) ?? [];
    group.push(f);
    byFormat.set(key, group);
  }
  return [...byFormat.values()].sort((a, b) => b.length - a.length)[0]!;
}

async function streamToFile(
  url: string,
  dest: string,
  opts: { signal?: AbortSignal },
  fetchFn: typeof fetch,
): Promise<void> {
  const res = await fetchFn(url, { signal: opts.signal });
  if (!res.ok || !res.body) {
    throw new Error(`archive.org download failed (${res.status}) for ${url}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const webStream = res.body as unknown as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(Readable.fromWeb(webStream), createWriteStream(dest));
}

function coerceCreator(creator: string | string[] | undefined): string {
  if (Array.isArray(creator)) return creator[0] ?? '';
  return creator ?? '';
}

async function fetchMetadata(
  id: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<ArchiveMetadata> {
  const res = await fetchFn(`${META_BASE}/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`archive.org metadata lookup failed (${res.status}) for "${id}"`);
  return (await res.json()) as ArchiveMetadata;
}

/** Resolve an archive.org URL: download its audio into `stagingDir` and return the staged files + meta. */
export async function resolveArchive(
  url: string,
  opts: ArchiveEngineOpts,
): Promise<ResolvedArchive> {
  const id = parseArchiveIdentifier(url);
  if (!id) throw new Error(`Not an archive.org item URL: ${url}`);
  const fetchFn = opts.fetchFn ?? fetch;
  const downloadFile = opts.downloadFile ?? ((u, dest, o) => streamToFile(u, dest, o, fetchFn));

  const meta = await fetchMetadata(id, fetchFn, opts.signal);
  const chosen = selectArchiveFiles(meta.files ?? [], opts.preferredFormats);
  if (chosen.length === 0) {
    throw new Error(`archive.org item "${id}" has no downloadable audio files`);
  }

  const creatorRaw = coerceCreator(meta.metadata?.creator) || 'Unknown Artist';
  const titleRaw = meta.metadata?.title || id;
  const albumDir = join(opts.stagingDir, safeSegment(creatorRaw), safeSegment(titleRaw));

  const files: ResolvedArchiveFile[] = [];
  for (const file of chosen) {
    const dest = join(albumDir, ...file.name.split('/').map(safeSegment));
    const fileUrl = `${DOWNLOAD_BASE}/${encodeURIComponent(id)}/${file.name
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    await downloadFile(fileUrl, dest, { signal: opts.signal });
    let size = 0;
    try {
      size = statSync(dest).size;
    } catch {
      size = 0;
    }
    files.push({
      path: dest,
      title: trackTitleFor(file.name),
      filename: basename(file.name),
      size,
    });
  }

  return { files, artist: creatorRaw, album: titleRaw };
}
