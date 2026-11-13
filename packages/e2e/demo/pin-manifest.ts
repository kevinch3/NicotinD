/**
 * Pins `albums.ts` to exact Internet Archive files: reads each item's metadata,
 * checks its licence against the allowlist, picks the VBR MP3 of every track
 * and the cover image, and writes `manifest.json` with each file's sha1 (the
 * hash the Archive publishes, so pinning needs no download). Re-run only when
 * the album list changes; the Pages build reads the committed manifest.
 *
 *   bun run packages/e2e/demo/pin-manifest.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ALBUM_SOURCES, isAllowedLicence, type DemoAlbumSource } from './albums.js';
import type { DemoManifest, ManifestAlbum, ManifestTrack } from './manifest.js';

interface IaFile {
  name: string;
  source?: string;
  format?: string;
  size?: string;
  sha1?: string;
  title?: string;
  track?: string;
  length?: string;
}

interface IaItem {
  metadata: Record<string, unknown>;
  files: IaFile[];
}

const first = (v: unknown): string => String(Array.isArray(v) ? v[0] : (v ?? '')).trim();

/** "04:36" | "276.84" → seconds. */
export function parseLength(raw: string | undefined): number {
  if (!raw) return 0;
  if (raw.includes(':')) return raw.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  return Number(raw) || 0;
}

/** "03" | "3/12" | undefined (falls back to a leading number in the file name). */
export function parseTrackNumber(file: IaFile): number {
  const fromTag = Number.parseInt(String(file.track ?? '').split('/')[0] ?? '', 10);
  if (Number.isFinite(fromTag) && fromTag > 0) return fromTag;
  const fromName = /(?:^|[\s_-])(\d{1,2})(?:[\s_.-])/.exec(file.name.replace(/\.[^.]+$/, ''));
  return fromName ? Number(fromName[1]) : 0;
}

export function pickTracks(files: IaFile[], src: DemoAlbumSource): ManifestTrack[] {
  const tracks = files
    .filter((f) => f.format === 'VBR MP3' && f.sha1)
    .map((f) => ({
      file: f.name,
      sha1: f.sha1!,
      size: Number(f.size ?? 0),
      title: (f.title ?? f.name.replace(/\.mp3$/i, '')).trim(),
      track: parseTrackNumber(f),
      seconds: Math.round(parseLength(f.length)),
    }))
    .filter((t) => !src.exclude?.test(t.title))
    .sort((a, b) => a.track - b.track || a.file.localeCompare(b.file))
    // An item holding both an MP3 and a FLAC original lists a VBR MP3 for each.
    .filter(
      (t, i, all) => all.findIndex((o) => o.title.toLowerCase() === t.title.toLowerCase()) === i,
    );
  return tracks.slice(0, src.maxTracks ?? tracks.length).map((t, i) => ({ ...t, track: i + 1 }));
}

export function pickCover(files: IaFile[]): ManifestAlbum['cover'] {
  const images = files
    .filter((f) => f.source === 'original' && /^(JPEG|PNG)$/.test(f.format ?? '') && f.sha1)
    .filter((f) => !/^__ia_thumb/.test(f.name))
    .sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0));
  const img = images[0];
  if (!img) return null;
  return { file: img.name, sha1: img.sha1!, size: Number(img.size ?? 0) };
}

async function pinAlbum(src: DemoAlbumSource): Promise<ManifestAlbum> {
  const res = await fetch(`https://archive.org/metadata/${src.ia}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${src.ia}: HTTP ${res.status}`);
  const item = (await res.json()) as IaItem;
  const licence = first(item.metadata.licenseurl);
  if (!isAllowedLicence(licence))
    throw new Error(`${src.ia}: licence not allowed (${licence || 'none'})`);
  const tracks = pickTracks(item.files, src);
  if (tracks.length === 0) throw new Error(`${src.ia}: no VBR MP3 tracks`);
  const cover = pickCover(item.files);
  if (!cover) throw new Error(`${src.ia}: no cover image`);
  const year = Number.parseInt(first(item.metadata.date ?? item.metadata.year).slice(0, 4), 10);
  return {
    ia: src.ia,
    artist: first(item.metadata.creator),
    title: first(item.metadata.title)
      .replace(/^.*? - /, '')
      .trim(),
    year: Number.isFinite(year) ? year : null,
    genre: src.genre,
    heldBack: src.heldBack === true,
    licence,
    sourceUrl: `https://archive.org/details/${src.ia}`,
    cover,
    tracks,
  };
}

if (import.meta.main) {
  const albums: ManifestAlbum[] = [];
  for (const src of DEMO_ALBUM_SOURCES) albums.push(await pinAlbum(src));
  const manifest: DemoManifest = { version: 1, albums };
  const out = join(dirname(fileURLToPath(import.meta.url)), 'manifest.json');
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const a of albums) {
    const mb = a.tracks.reduce((s, t) => s + t.size, 0) / 1e6;
    console.log(
      `${a.heldBack ? 'HELD ' : '     '}${a.artist} — ${a.title}: ${a.tracks.length} tracks, ${mb.toFixed(0)} MB mp3`,
    );
  }
}
