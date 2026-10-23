/**
 * Renders the demo catalog (`@nicotind/core` demo module) to disk for a REAL
 * server: tagged FLAC files synthesised by `renderTone`, plus a `cover.jpg` per
 * album rasterised from `coverSvg` in Chromium (the scanner reads folder art).
 *
 *   .tmp-demo/music/<Artist>/<Album>/NN - Title.flac   the `library` pool
 *   .tmp-demo/pool/<artist>/<album>/NN - Title.flac    the `acquirable` pool,
 *                                                      served by the demo addon
 *
 * Nothing here is committed or shipped — it is regenerated on demand, and the
 * output is a pure function of the catalog, so a rerun reproduces it exactly.
 * Run directly (`bun run tour/make-demo-library.ts [--force]`) or let the tour
 * config call `ensureDemoLibrary()`.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.js';
import {
  DEMO_ALBUMS,
  coverSvg,
  demoSlug,
  demoTracks,
  renderTone,
  toPcm16,
  type DemoAlbum,
  type DemoTrack,
} from '../../core/src/demo/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEMO_ROOT = resolve(HERE, '../.tmp-demo');
export const DEMO_MUSIC_DIR = join(DEMO_ROOT, 'music');
export const DEMO_POOL_DIR = join(DEMO_ROOT, 'pool');

/** 22.05 kHz mono keeps a ~70 s track near 1 MB of FLAC; tones need no more. */
const SAMPLE_RATE = 22050;

export function albumDir(album: DemoAlbum): string {
  return album.pool === 'library'
    ? join(DEMO_MUSIC_DIR, album.artist, album.title)
    : join(DEMO_POOL_DIR, demoSlug(album.artist), demoSlug(album.title));
}

export function trackFileName(track: DemoTrack): string {
  return `${String(track.trackNumber).padStart(2, '0')} - ${track.title}.flac`;
}

async function writeFlac(track: DemoTrack, file: string): Promise<void> {
  const pcm = toPcm16(renderTone(track.tone, SAMPLE_RATE));
  const tags: Record<string, string> = {
    title: track.title,
    artist: track.artist,
    album: track.album,
    album_artist: track.artist,
    track: `${track.trackNumber}/${track.totalTracks}`,
    date: String(track.year),
    genre: track.genre,
    bpm: String(track.tone.bpm),
  };
  const proc = Bun.spawn(
    [
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-i',
      'pipe:0',
      ...Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]),
      file,
    ],
    { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
  );
  proc.stdin.write(new Uint8Array(pcm.buffer));
  await proc.stdin.end();
  if ((await proc.exited) !== 0) {
    throw new Error(`ffmpeg failed for ${file}: ${await new Response(proc.stderr).text()}`);
  }
}

async function writeCovers(): Promise<void> {
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
    for (const album of DEMO_ALBUMS) {
      await page.setContent(
        `<html><body style="margin:0">${coverSvg({ artist: album.artist, title: album.title, motif: album.cover })}</body></html>`,
      );
      const jpg = await page.locator('svg').screenshot({ type: 'jpeg', quality: 88 });
      writeFileSync(join(albumDir(album), 'cover.jpg'), jpg);
    }
  } finally {
    await browser.close();
  }
}

function isComplete(): boolean {
  return DEMO_ALBUMS.every((album) => {
    const dir = albumDir(album);
    if (!existsSync(join(dir, 'cover.jpg'))) return false;
    const files = new Set(readdirSync(dir));
    return demoTracks(album).every((t) => files.has(trackFileName(t)));
  });
}

/** Generate the demo library unless a complete copy is already on disk. */
export async function ensureDemoLibrary(opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && existsSync(DEMO_ROOT) && isComplete()) return;
  rmSync(DEMO_ROOT, { recursive: true, force: true });
  for (const album of DEMO_ALBUMS) {
    const dir = albumDir(album);
    mkdirSync(dir, { recursive: true });
    for (const track of demoTracks(album)) await writeFlac(track, join(dir, trackFileName(track)));
  }
  await writeCovers();
}

if (import.meta.main) {
  const started = Date.now();
  await ensureDemoLibrary({ force: process.argv.includes('--force') });
  console.log(`demo library ready in ${DEMO_ROOT} (${Date.now() - started} ms)`);
}
