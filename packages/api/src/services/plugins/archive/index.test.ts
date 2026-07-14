import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePluginManifest, type PluginHostContext } from '@nicotind/core';
import {
  ArchivePlugin,
  parseArchiveIdentifier,
  selectArchiveFiles,
  type ArchivePluginConfig,
} from './index.js';

const cfg = (over: Partial<ArchivePluginConfig> = {}): ArchivePluginConfig => ({
  enabled: true,
  preferredFormats: ['MP3', 'FLAC'],
  ...over,
});

let staging: string;
const progress: Array<{ done: number; total: number }> = [];
const labels: Array<{ jobId: string; label: string }> = [];
const tracks: Array<{ jobId: string; title: string; status: string }> = [];
function fakeCtx(): PluginHostContext {
  return {
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as unknown as PluginHostContext['logger'],
    config: {},
    allocStagingDir(jobId) {
      const dir = join(staging, jobId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    emitProgress(_jobId, p) {
      progress.push(p);
    },
    emitLabel(jobId, label) {
      labels.push({ jobId, label });
    },
    emitTrack(jobId, track) {
      tracks.push({ jobId, title: track.title, status: track.status });
    },
    storage: { get: () => null, set() {}, delete() {} },
  };
}

/** A fetch fake that returns the given metadata JSON for /metadata/<id>. */
function metadataFetch(meta: unknown, ok = true): typeof fetch {
  return mock(async (_url: string) => ({
    ok,
    status: ok ? 200 : 404,
    json: async () => meta,
  })) as unknown as typeof fetch;
}

const SAMPLE_META = {
  metadata: { title: 'Una Cerveza', creator: 'Ráfaga', identifier: 'rafaga-una-cerveza' },
  files: [
    { name: 'track01.mp3', format: 'VBR MP3' },
    { name: 'track02.mp3', format: 'VBR MP3' },
    { name: 'track01.flac', format: 'Flac' },
    { name: 'cover.jpg', format: 'JPEG' },
    { name: '__ia_thumb.jpg', format: 'Item Tile' },
  ],
};

describe('parseArchiveIdentifier', () => {
  it('extracts the id from details/download/compress/metadata URLs', () => {
    expect(parseArchiveIdentifier('https://archive.org/details/foo-123')).toBe('foo-123');
    expect(parseArchiveIdentifier('https://archive.org/download/foo-123/track.mp3')).toBe(
      'foo-123',
    );
    expect(
      parseArchiveIdentifier('https://archive.org/compress/foo-123/formats=VBR%20MP3&file=/x.zip'),
    ).toBe('foo-123');
    expect(parseArchiveIdentifier('https://archive.org/metadata/foo-123')).toBe('foo-123');
  });

  it('rejects non-archive URLs', () => {
    expect(parseArchiveIdentifier('https://www.youtube.com/watch?v=x')).toBeNull();
    expect(parseArchiveIdentifier('https://open.spotify.com/track/x')).toBeNull();
    expect(parseArchiveIdentifier('https://archive.org/')).toBeNull();
    expect(parseArchiveIdentifier('not a url')).toBeNull();
  });
});

describe('selectArchiveFiles', () => {
  it('prefers MP3, then FLAC, and ignores non-audio', () => {
    const mp3 = selectArchiveFiles(SAMPLE_META.files, ['MP3', 'FLAC']);
    expect(mp3.map((f) => f.name)).toEqual(['track01.mp3', 'track02.mp3']);

    const flacFirst = selectArchiveFiles(SAMPLE_META.files, ['FLAC', 'MP3']);
    expect(flacFirst.map((f) => f.name)).toEqual(['track01.flac']);
  });

  it('falls back to the largest audio group when no preferred format matches', () => {
    const files = [
      { name: 'a.ogg', format: 'Ogg Vorbis' },
      { name: 'b.ogg', format: 'Ogg Vorbis' },
      { name: 'c.aiff', format: 'AIFF' },
    ];
    expect(selectArchiveFiles(files, ['MP3', 'FLAC']).map((f) => f.name)).toEqual([
      'a.ogg',
      'b.ogg',
    ]);
  });

  it('returns empty when there is no audio', () => {
    expect(selectArchiveFiles([{ name: 'cover.jpg', format: 'JPEG' }], ['MP3'])).toEqual([]);
  });
});

describe('ArchivePlugin', () => {
  beforeEach(() => {
    progress.length = 0;
    labels.length = 0;
    tracks.length = 0;
    mkdirSync(tmpdir(), { recursive: true });
    staging = mkdtempSync(join(tmpdir(), 'nd-archive-'));
  });
  afterEach(() => rmSync(staging, { recursive: true, force: true }));

  it('has a valid consent-gated, binary-free acquisition manifest', () => {
    const p = new ArchivePlugin(cfg());
    expect(validatePluginManifest(p.manifest)).toEqual([]);
    expect(p.manifest.capabilities).toEqual(['resolve']);
    expect(p.manifest.requirements?.binaries).toEqual([]);
    expect(p.manifest.compliance?.requiresConsent).toBe(true);
    expect(p.manifest.defaultEnabled).toBe(false);
  });

  it('handles archive.org URLs only', () => {
    const p = new ArchivePlugin(cfg());
    expect(p.resolve.canHandle('https://archive.org/details/x')).toBe(true);
    expect(p.resolve.canHandle('https://www.youtube.com/watch?v=x')).toBe(false);
  });

  it('reports availability from the enabled flag (no binary)', async () => {
    expect(await new ArchivePlugin(cfg({ enabled: false })).isAvailable()).toBe(false);
    expect(await new ArchivePlugin(cfg({ enabled: true })).isAvailable()).toBe(true);
  });

  it('resolves: downloads the MP3 files, stages under creator/title, emits progress', async () => {
    const calls: Array<{ url: string; dest: string }> = [];
    const downloadFile = mock(async (url: string, dest: string) => {
      calls.push({ url, dest });
    });
    const p = new ArchivePlugin(cfg(), {
      fetchFn: metadataFetch(SAMPLE_META),
      downloadFile,
    });
    await p.init(fakeCtx());

    const paths = await p.resolve.resolve('https://archive.org/details/rafaga-una-cerveza', 'j1');

    expect(paths).toHaveLength(2);
    // Staged under <staging>/<creator>/<title>/<file>.
    expect(paths[0]).toContain(join('Ráfaga', 'Una Cerveza', 'track01.mp3'));
    // Download URLs point at archive.org/download/<id>/<name>.
    expect(calls[0]!.url).toBe('https://archive.org/download/rafaga-una-cerveza/track01.mp3');
    // Progress reported per file.
    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  it('emits label once with the item title', async () => {
    const downloadFile = mock(async () => {});
    const p = new ArchivePlugin(cfg(), {
      fetchFn: metadataFetch(SAMPLE_META),
      downloadFile,
    });
    await p.init(fakeCtx());

    await p.resolve.resolve('https://archive.org/details/rafaga-una-cerveza', 'j-label');

    expect(labels).toHaveLength(1);
    expect(labels[0]).toEqual({ jobId: 'j-label', label: 'Una Cerveza' });
  });

  it('emits track events: downloading then done for each file', async () => {
    const downloadFile = mock(async () => {});
    const p = new ArchivePlugin(cfg(), {
      fetchFn: metadataFetch(SAMPLE_META),
      downloadFile,
    });
    await p.init(fakeCtx());

    await p.resolve.resolve('https://archive.org/details/rafaga-una-cerveza', 'j-tracks');

    // Two files (MP3s): track01.mp3 and track02.mp3 → 2 files × 2 events = 4 events
    expect(tracks).toHaveLength(4);
    // First file: downloading, then done
    expect(tracks[0]).toEqual({ jobId: 'j-tracks', title: 'track01.mp3', status: 'downloading' });
    expect(tracks[1]).toEqual({ jobId: 'j-tracks', title: 'track01.mp3', status: 'done' });
    // Second file: downloading, then done
    expect(tracks[2]).toEqual({ jobId: 'j-tracks', title: 'track02.mp3', status: 'downloading' });
    expect(tracks[3]).toEqual({ jobId: 'j-tracks', title: 'track02.mp3', status: 'done' });
  });

  it('rejects when metadata lookup 404s', async () => {
    const p = new ArchivePlugin(cfg(), { fetchFn: metadataFetch({}, false) });
    await p.init(fakeCtx());
    await expect(p.resolve.resolve('https://archive.org/details/missing', 'j2')).rejects.toThrow(
      /metadata lookup failed/,
    );
  });

  it('rejects when the item has no audio files', async () => {
    const p = new ArchivePlugin(cfg(), {
      fetchFn: metadataFetch({
        metadata: { title: 'x' },
        files: [{ name: 'a.jpg', format: 'JPEG' }],
      }),
      downloadFile: mock(async () => {}),
    });
    await p.init(fakeCtx());
    await expect(p.resolve.resolve('https://archive.org/details/x', 'j3')).rejects.toThrow(
      /no downloadable audio/,
    );
  });
});
