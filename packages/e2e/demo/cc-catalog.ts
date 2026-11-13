/**
 * The pinned CC catalog laid out on disk for a REAL server, the same two pools
 * the tone catalog uses (`tour/make-demo-library.ts`):
 *
 *   .tmp-cc-demo/cache/<ia>/<file>                 downloads, sha1-verified
 *   .tmp-cc-demo/music/<Artist>/<Album>/NN - T.mp3  the library pool
 *   .tmp-cc-demo/pool/<artist>/<album>/NN - T.mp3   held back, served by the demo addon
 *
 *   bun run packages/e2e/demo/cc-catalog.ts          fetch + lay out (idempotent)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoSlug } from '../../core/src/demo/index.js';
import type { StandInAlbum } from '../tour/stand-in-catalog.js';
import { iaFileUrl, loadManifest, type DemoManifest, type ManifestAlbum } from './manifest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CC_ROOT = resolve(HERE, '../.tmp-cc-demo');
const CACHE_DIR = join(CC_ROOT, 'cache');
export const CC_MUSIC_DIR = join(CC_ROOT, 'music');
export const CC_POOL_DIR = join(CC_ROOT, 'pool');

/** Path-safe for every filesystem the scanner runs on. */
export function safeName(text: string): string {
  return text
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ccAlbumDir(album: ManifestAlbum): string {
  return album.heldBack
    ? join(CC_POOL_DIR, demoSlug(album.artist), demoSlug(album.title))
    : join(CC_MUSIC_DIR, safeName(album.artist), safeName(album.title));
}

export function ccTrackFileName(track: { track: number; title: string }): string {
  return `${String(track.track).padStart(2, '0')} - ${safeName(track.title)}.mp3`;
}

export function ccCatalog(manifest: DemoManifest = loadManifest()): StandInAlbum[] {
  return manifest.albums.map((a) => ({
    artist: a.artist,
    title: a.title,
    year: a.year ?? 2020,
    genre: a.genre,
    pool: a.heldBack ? 'acquirable' : 'library',
    dir: ccAlbumDir(a),
    tracks: a.tracks.map((t) => ({
      title: t.title,
      trackNumber: t.track,
      durationSec: t.seconds,
      seed: `${a.ia}\u0000${t.file}`,
      fileName: ccTrackFileName(t),
    })),
  }));
}

function sha1File(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

async function fetchVerified(ia: string, file: string, sha1: string): Promise<string> {
  const dest = join(CACHE_DIR, ia, file);
  if (existsSync(dest) && sha1File(dest) === sha1) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(iaFileUrl(ia, file), { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const got = createHash('sha1').update(bytes).digest('hex');
      if (got !== sha1) throw new Error(`sha1 ${got} != pinned ${sha1}`);
      writeFileSync(dest, bytes);
      return dest;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${ia}/${file}: ${(err as Error).message}`);
      await Bun.sleep(2_000 * attempt);
    }
  }
}

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffmpeg ${code}: ${await new Response(proc.stderr).text()}`);
}

/**
 * Re-tags each MP3 from the manifest (the Archive's own tags vary in quality;
 * the manifest is what the credits page shows, so the library must match it)
 * without re-encoding, and writes a 600 px `cover.jpg` per album folder.
 */
export async function layOutCcLibrary(manifest: DemoManifest = loadManifest()): Promise<void> {
  rmSync(CC_MUSIC_DIR, { recursive: true, force: true });
  rmSync(CC_POOL_DIR, { recursive: true, force: true });
  for (const album of manifest.albums) {
    const dir = ccAlbumDir(album);
    mkdirSync(dir, { recursive: true });
    if (album.cover) {
      const src = await fetchVerified(album.ia, album.cover.file, album.cover.sha1);
      await ffmpeg([
        '-i',
        src,
        '-vf',
        'scale=600:600:force_original_aspect_ratio=increase,crop=600:600',
        '-q:v',
        '3',
        join(dir, 'cover.jpg'),
      ]);
    }
    for (const t of album.tracks) {
      const src = await fetchVerified(album.ia, t.file, t.sha1);
      const tags: Record<string, string> = {
        title: t.title,
        artist: album.artist,
        album_artist: album.artist,
        album: album.title,
        track: `${t.track}/${album.tracks.length}`,
        genre: album.genre,
        copyright: album.licence,
        ...(album.year ? { date: String(album.year) } : {}),
      };
      await ffmpeg([
        '-i',
        src,
        '-map',
        '0:a',
        '-c',
        'copy',
        '-map_metadata',
        '-1',
        '-id3v2_version',
        '3',
        ...Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]),
        join(dir, ccTrackFileName(t)),
      ]);
    }
    console.log(`laid out ${album.artist} — ${album.title} (${album.tracks.length})`);
  }
}

if (import.meta.main) await layOutCcLibrary();
