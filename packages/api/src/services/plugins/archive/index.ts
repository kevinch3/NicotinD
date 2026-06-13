import { createWriteStream, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import type { Plugin, PluginManifest, PluginHostContext, ResolveCapability } from '@nicotind/core';
import { AUDIO_EXTENSIONS } from '../acquire/process.js';

export interface ArchivePluginConfig {
  enabled: boolean;
  /**
   * Ordered preference of audio formats to pull. Each entry is matched
   * case-insensitively as a substring of archive.org's `format` field, so
   * 'MP3' matches "VBR MP3"/"128Kbps MP3" and 'FLAC' matches "Flac"/"24bit Flac".
   */
  preferredFormats: string[];
}

/** A single audio file the metadata API reports for an item. */
interface ArchiveFile {
  name: string;
  format?: string;
  size?: string;
}

interface ArchiveMetadata {
  metadata?: { title?: string; creator?: string | string[]; identifier?: string };
  files?: ArchiveFile[];
}

/** Injected so tests run without network and without mocking node builtins. */
export interface ArchivePluginDeps {
  fetchFn?: typeof fetch;
  /** Stream a remote file to `dest`. Default streams via fetch; tests fake it. */
  downloadFile?: (url: string, dest: string, opts: { signal?: AbortSignal }) => Promise<void>;
}

const DISCLAIMER =
  'archive.org (the Internet Archive) hosts user-uploaded recordings. You are ' +
  'responsible for confirming an item is legitimately distributable and for ' +
  'complying with copyright law in your jurisdiction.';

const META_BASE = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';

/** Make a string safe as a single path segment (no separators, traversal, or control chars). */
function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[/\\]/g, '-')
    .replace(/\p{Cc}/gu, '') // strip control characters
    .replace(/^\.+$/, '') // neutralise "." / ".." traversal
    .trim();
  return cleaned || 'Unknown';
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
  // /details/<id>, /download/<id>/..., /compress/<id>/..., /metadata/<id>, /stream/<id>/...
  const known = new Set(['details', 'download', 'compress', 'metadata', 'stream', 'embed']);
  if (parts.length >= 2 && known.has(parts[0]!)) return decodeURIComponent(parts[1]!);
  return null;
}

const isAudio = (f: ArchiveFile): boolean => AUDIO_EXTENSIONS.has(extname(f.name).toLowerCase());

/**
 * Pick the audio files to download from an item's file list: the first format
 * (by `preferred` order) that is present, else the single most common audio
 * format group, so we never mix a FLAC original with its derived MP3 copies.
 */
export function selectArchiveFiles(files: ArchiveFile[], preferred: string[]): ArchiveFile[] {
  const audio = files.filter(isAudio);
  if (audio.length === 0) return [];
  for (const token of preferred) {
    const t = token.toLowerCase();
    const matches = audio.filter((f) => (f.format ?? '').toLowerCase().includes(t));
    if (matches.length > 0) return matches;
  }
  // No preferred format present — fall back to the largest single-format group.
  const byFormat = new Map<string, ArchiveFile[]>();
  for (const f of audio) {
    const key = f.format ?? extname(f.name).toLowerCase();
    const group = byFormat.get(key) ?? [];
    group.push(f);
    byFormat.set(key, group);
  }
  return [...byFormat.values()].sort((a, b) => b.length - a.length)[0]!;
}

/** Default streaming downloader — pulls the body to disk without buffering it all. */
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

/** archive.org `creator` may be a string or an array of strings. */
function coerceCreator(creator: string | string[] | undefined): string {
  if (Array.isArray(creator)) return creator[0] ?? '';
  return creator ?? '';
}

/**
 * Acquisition plugin that pulls audio from an archive.org item by URL. Pure JS
 * (no external binary): it reads the item's `/metadata/<id>` file list, picks one
 * audio format (MP3-preferred), and downloads those files into the host staging
 * dir. The host (AcquireWatcher) owns ingest — this only stages + returns paths.
 */
export class ArchivePlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'archive',
    name: 'archive.org',
    description: 'Download audio from an archive.org item by URL (Internet Archive).',
    kind: 'acquisition',
    capabilities: ['resolve'],
    requirements: { binaries: [] },
    configSchema: z
      .object({
        preferredFormats: z.array(z.string()).optional(),
      })
      .partial(),
    compliance: { disclaimer: DISCLAIMER, requiresConsent: true },
    defaultEnabled: false,
  };

  private ctx: PluginHostContext | null = null;
  private cfg: ArchivePluginConfig;
  private readonly fetchFn: typeof fetch;
  private readonly downloadFile: NonNullable<ArchivePluginDeps['downloadFile']>;
  /** jobId → AbortController, for cancel. */
  private activeRuns = new Map<string, AbortController>();

  constructor(config: ArchivePluginConfig, deps: ArchivePluginDeps = {}) {
    this.cfg = config;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.downloadFile =
      deps.downloadFile ?? ((url, dest, opts) => streamToFile(url, dest, opts, this.fetchFn));
  }

  readonly resolve: ResolveCapability = {
    canHandle: (url: string) => parseArchiveIdentifier(url) !== null,
    resolve: (url, jobId) => this.run(url, jobId),
    cancel: (jobId) => {
      const ctrl = this.activeRuns.get(jobId);
      if (!ctrl) return false;
      ctrl.abort();
      return true;
    },
  };

  async init(ctx: PluginHostContext): Promise<void> {
    this.ctx = ctx;
    this.cfg = { ...this.cfg, ...(ctx.config as Partial<ArchivePluginConfig>) };
  }

  async isAvailable(): Promise<boolean> {
    // No binary requirement — availability tracks the config flag (the registry's
    // enable/disable is the real gate).
    return this.cfg.enabled;
  }

  private async run(url: string, jobId: string): Promise<string[]> {
    if (!this.ctx) throw new Error('archive.org plugin not initialized');
    const id = parseArchiveIdentifier(url);
    if (!id) throw new Error(`Not an archive.org item URL: ${url}`);

    const controller = new AbortController();
    this.activeRuns.set(jobId, controller);
    try {
      const meta = await this.fetchMetadata(id, controller.signal);
      const chosen = selectArchiveFiles(meta.files ?? [], this.cfg.preferredFormats);
      if (chosen.length === 0) {
        throw new Error(`archive.org item "${id}" has no downloadable audio files`);
      }

      const stagingDir = this.ctx.allocStagingDir(jobId);
      const creator = safeSegment(coerceCreator(meta.metadata?.creator) || 'Unknown Artist');
      const title = safeSegment(meta.metadata?.title || id);
      const albumDir = join(stagingDir, creator, title);

      const staged: string[] = [];
      for (let i = 0; i < chosen.length; i++) {
        const file = chosen[i]!;
        const dest = join(albumDir, ...file.name.split('/').map(safeSegment));
        const fileUrl = `${DOWNLOAD_BASE}/${encodeURIComponent(id)}/${file.name
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
        await this.downloadFile(fileUrl, dest, { signal: controller.signal });
        staged.push(dest);
        this.ctx.emitProgress(jobId, { done: i + 1, total: chosen.length });
      }
      return staged;
    } finally {
      this.activeRuns.delete(jobId);
    }
  }

  private async fetchMetadata(id: string, signal: AbortSignal): Promise<ArchiveMetadata> {
    const res = await this.fetchFn(`${META_BASE}/${encodeURIComponent(id)}`, { signal });
    if (!res.ok) throw new Error(`archive.org metadata lookup failed (${res.status}) for "${id}"`);
    return (await res.json()) as ArchiveMetadata;
  }
}
