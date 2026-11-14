import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
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

/** A file chosen for download, known before any byte of it arrives. */
export interface PlannedArchiveFile {
  title: string;
  filename: string;
  /** The size archive.org's metadata declares (0 when it declares none). */
  size: number;
}

export interface ArchiveDownloadOpts {
  signal?: AbortSignal;
  /** Bytes of this file written so far. */
  onBytes?: (bytes: number) => void;
  /** Override the stall timeout (tests). */
  idleTimeoutMs?: number;
}

export interface ArchiveEngineOpts {
  stagingDir: string;
  preferredFormats: string[];
  fetchFn?: typeof fetch;
  downloadFile?: (url: string, dest: string, opts: ArchiveDownloadOpts) => Promise<void>;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  /** Once, after the metadata lookup: the item's meta and every file about to download. */
  onPlan?: (plan: { artist: string; album: string; files: PlannedArchiveFile[] }) => void;
  onProgress?: (index: number, bytes: number) => void;
  onFileDone?: (index: number, file: ResolvedArchiveFile) => void;
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

/** No byte for this long fails the file: a peer that stops sending never errors on its own. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/**
 * Stream to `<dest>.part` and rename on success, so a file at its final name is
 * always whole — a restart or a dropped connection mid-file leaves no truncated
 * MP3 that looks complete.
 *
 * Reads the web stream directly rather than through `Readable.fromWeb` +
 * `pipeline`: under Bun that pipeline never settles when the body errors, so a
 * dropped connection hung the job at `active` forever.
 */
async function streamToFile(
  url: string,
  dest: string,
  opts: ArchiveDownloadOpts,
  fetchFn: typeof fetch,
): Promise<void> {
  const idle = new AbortController();
  const idleMs = opts.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => idle.abort(new Error(`archive.org download stalled (no data for ${idleMs / 1000}s)`)),
      idleMs,
    );
  };
  const signal = opts.signal ? AbortSignal.any([opts.signal, idle.signal]) : idle.signal;
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(signal.reason ?? new Error('archive.org download aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {});

  const part = `${dest}.part`;
  let out: ReturnType<typeof createWriteStream> | undefined;
  try {
    arm();
    const res = await Promise.race([fetchFn(url, { signal }), aborted]);
    if (!res.ok || !res.body) {
      throw new Error(`archive.org download failed (${res.status}) for ${url}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    out = createWriteStream(part);
    const reader = res.body.getReader();
    let written = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        arm();
        written += value.byteLength;
        if (!out.write(value)) await Promise.race([once(out, 'drain'), aborted]);
        opts.onBytes?.(written);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    out.end();
    await finished(out);
    renameSync(part, dest);
  } catch (err) {
    if (out) {
      const stream = out;
      stream.destroy();
      // why: the stream opens its file asynchronously; deleting before it
      // closes lets that open recreate the `.part` afterwards.
      if (!stream.closed) await once(stream, 'close');
    }
    rmSync(part, { force: true });
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  opts.onPlan?.({
    artist: creatorRaw,
    album: titleRaw,
    files: chosen.map((f) => ({
      title: trackTitleFor(f.name),
      filename: basename(f.name),
      size: Number(f.size) || 0,
    })),
  });

  const files: ResolvedArchiveFile[] = [];
  for (const [index, file] of chosen.entries()) {
    const dest = join(albumDir, ...file.name.split('/').map(safeSegment));
    const fileUrl = `${DOWNLOAD_BASE}/${encodeURIComponent(id)}/${file.name
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    await downloadFile(fileUrl, dest, {
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      onBytes: (bytes) => opts.onProgress?.(index, bytes),
    });
    let size = 0;
    try {
      size = statSync(dest).size;
    } catch {
      size = 0;
    }
    const resolved = {
      path: dest,
      title: trackTitleFor(file.name),
      filename: basename(file.name),
      size,
    };
    files.push(resolved);
    opts.onFileDone?.(index, resolved);
  }

  return { files, artist: creatorRaw, album: titleRaw };
}
