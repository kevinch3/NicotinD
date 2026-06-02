/**
 * Consolidate duplicate album *folders* and trim each album to one file per
 * track. The companion to repair-album-dupes (which only de-dups within a single
 * folder) — this one works *across* folders.
 *
 *   bun run packages/api/src/scripts/repair-album-folders.ts          # dry run
 *   bun run packages/api/src/scripts/repair-album-folders.ts --apply  # move + delete
 *
 * Background:
 *   Before the idempotent-hunt fix, an album could be acquired into several
 *   folders — a base edition, a "(2011 Remaster)", a "(Deluxe)" — each landing as
 *   its own `<Artist>/<Album …>` dir, so Navidrome showed several cards and, once
 *   merged, the union listed every track 2–4× (studio + 5.1 mix + new mix + …).
 *
 * How it works:
 *   1. Walks `<musicDir>/<Artist>/<Album>/` and groups folders that are the same
 *      album via `albumGroupKey` (edition-stripped artist+title).
 *   2. Picks the fullest folder as canonical; the rest are merged into it.
 *   3. Trims to one file per track: when the album has a stored canonical
 *      tracklist (`album_jobs.canonical_tracks_json`), keeps the cleanest best
 *      file per canonical track and drops everything else (deluxe/5.1/remix
 *      extras); otherwise collapses only true-duplicate copies (`dupKey`).
 *   4. Removes emptied folders; best-effort prunes `completed_downloads` rows.
 *
 * Safe by default: dry-run unless --apply. Moves/deletes are NOT reversible —
 * review the dry-run first. After applying, trigger a Navidrome rescan.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { resolve, join, basename, extname } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { dupKey, pickKeeper, type DupFile } from '../services/album-dedupe.js';
import { AUDIO_EXTS } from '../services/audio-tags.js';
import { albumGroupKey, normalizeForGrouping } from '../services/album-grouping.js';
import { normalizeTitle, titlesOverlap } from '../services/album-hunter.service.js';

export interface FolderEntry {
  artist: string;
  album: string;
  dir: string;
}

/** A file plus the folder it currently lives in (for cross-folder planning). */
export interface SourcedFile extends DupFile {
  dir: string;
}

/** Group album folders that are the same release (per edition-stripped key). */
export function groupFoldersByAlbum(folders: FolderEntry[]): FolderEntry[][] {
  const map = new Map<string, FolderEntry[]>();
  for (const f of folders) {
    const key = albumGroupKey(f.artist, f.album);
    const bucket = map.get(key);
    if (bucket) bucket.push(f);
    else map.set(key, [f]);
  }
  return [...map.values()];
}

const stripExt = (name: string): string => name.slice(0, name.length - extname(name).length);

/** Words in a filename beyond the canonical title — a proxy for version cruft. */
function extraTokens(canonicalNorm: string, fileName: string): number {
  const canon = new Set(canonicalNorm.split(' ').filter(Boolean));
  return normalizeTitle(stripExt(fileName))
    .split(' ')
    .filter(Boolean)
    .reduce((n, w) => (canon.has(w) ? n : n + 1), 0);
}

/**
 * Decide which of an album's files (gathered across all its folders) to keep and
 * which to drop. With a canonical tracklist: keep one best file per canonical
 * track — the cleanest match (fewest extra words → no "(5.1 mix)"), then FLAC/
 * size via `pickKeeper` — and drop everything unmatched/extra. Without one:
 * collapse only true-duplicate copies (`dupKey`), keeping every distinct track.
 */
export function planTrackKeepers<T extends DupFile>(
  files: T[],
  canonicalTitles?: string[],
): { keep: T[]; drop: T[] } {
  if (canonicalTitles && canonicalTitles.length > 0) {
    const claimed = new Set<T>(); // chosen keeper for some canonical track
    const matched = new Set<T>(); // overlaps *some* canonical track (so a known version)
    for (const rawTitle of canonicalTitles) {
      const title = normalizeTitle(rawTitle);
      const cands = files.filter((f) => titlesOverlap(title, normalizeTitle(stripExt(f.name))));
      for (const c of cands) matched.add(c);
      const unclaimed = cands.filter((f) => !claimed.has(f));
      if (!unclaimed.length) continue;
      const best = [...unclaimed].sort((a, b) => {
        const ea = extraTokens(title, a.name);
        const eb = extraTokens(title, b.name);
        if (ea !== eb) return ea - eb; // cleanest match first
        return pickKeeper([a, b])[0] === a ? -1 : 1; // then FLAC/size/suffix
      })[0]!;
      claimed.add(best);
    }
    // Keep the chosen per-track files AND every file that matched NO canonical
    // track — an unmatched file is an unknown/bonus track, never a redundant
    // version, so we must not silently delete it. Only drop files that matched a
    // canonical track but lost to a cleaner copy (the (5.1 mix)/(New Mix) dupes).
    const keep = files.filter((f) => claimed.has(f) || !matched.has(f));
    return { keep, drop: files.filter((f) => matched.has(f) && !claimed.has(f)) };
  }

  // No canonical list — collapse true-duplicate copies only.
  const groups = new Map<string, T[]>();
  for (const f of files) {
    const k = dupKey(f.name);
    const bucket = groups.get(k);
    if (bucket) bucket.push(f);
    else groups.set(k, [f]);
  }
  const keep: T[] = [];
  const drop: T[] = [];
  for (const g of groups.values()) {
    const ordered = pickKeeper(g) as T[];
    keep.push(ordered[0]!);
    drop.push(...ordered.slice(1));
  }
  return { keep, drop };
}

// ----- CLI plumbing (not exercised by unit tests) -----

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadConfig(): { dataDir: string; musicDir: string } {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  const dataDir = expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
  const musicDirRaw = process.env.NICOTIND_MUSIC_DIR ?? (fileConfig.musicDir as string | undefined);
  if (!musicDirRaw) throw new Error('musicDir not configured');
  return { dataDir, musicDir: expandHome(musicDirRaw) };
}

function collectAlbumFolders(musicDir: string): FolderEntry[] {
  const out: FolderEntry[] = [];
  let artists: string[];
  try {
    artists = readdirSync(musicDir);
  } catch {
    return out;
  }
  for (const artist of artists) {
    const artistDir = join(musicDir, artist);
    try {
      if (!statSync(artistDir).isDirectory()) continue;
    } catch {
      continue;
    }
    let albums: string[];
    try {
      albums = readdirSync(artistDir);
    } catch {
      continue;
    }
    for (const album of albums) {
      if (album === 'Singles') continue; // owned by repair-singles
      const dir = join(artistDir, album);
      try {
        if (statSync(dir).isDirectory()) out.push({ artist, album, dir });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

function audioFilesIn(dir: string): SourcedFile[] {
  const out: SourcedFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!AUDIO_EXTS.has(extname(name).toLowerCase())) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) out.push({ name, size: st.size, dir });
    } catch {
      /* vanished */
    }
  }
  return out;
}

/** Canonical tracklist for an album from a recorded hunt job, if one matches. */
function lookupCanonicalTitles(db: Database, artist: string, album: string): string[] | undefined {
  const rows = db
    .query<{ album_title: string | null; artist_name: string | null; canonical_tracks_json: string }, []>(
      `SELECT album_title, artist_name, canonical_tracks_json FROM album_jobs
       WHERE album_title IS NOT NULL`,
    )
    .all();
  const wantAlbum = normalizeForGrouping(album);
  const wantArtist = normalizeForGrouping(artist);
  for (const r of rows) {
    if (
      r.album_title &&
      normalizeForGrouping(r.album_title) === wantAlbum &&
      (!r.artist_name || normalizeForGrouping(r.artist_name) === wantArtist)
    ) {
      try {
        const titles = JSON.parse(r.canonical_tracks_json) as string[];
        if (titles.length) return titles;
      } catch {
        /* malformed — ignore */
      }
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { dataDir, musicDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readwrite: true });
  db.run('PRAGMA busy_timeout = 5000');
  const logPath = join(dataDir, 'repair-album-folders.log');

  console.log(`Mode      : ${apply ? 'APPLY (moving + deleting)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir : ${musicDir}`);
  console.log(`Database  : ${dbPath}`);
  if (apply) console.log(`Log       : ${logPath}\n`);

  let mergedFolders = 0;
  let filesMoved = 0;
  let filesDeleted = 0;
  let bytesFreed = 0;

  for (const group of groupFoldersByAlbum(collectAlbumFolders(musicDir))) {
    // Canonical folder = the one with the most audio files.
    const withCounts = group
      .map((f) => ({ f, files: audioFilesIn(f.dir) }))
      .sort((a, b) => b.files.length - a.files.length);
    const canonical = withCounts[0]!;
    const allFiles = withCounts.flatMap((x) => x.files);
    if (allFiles.length === 0) continue;

    const canonicalTitles = lookupCanonicalTitles(db, canonical.f.artist, canonical.f.album);
    const { keep, drop } = planTrackKeepers(allFiles, canonicalTitles);

    const foreignKeepers = keep.filter((k) => k.dir !== canonical.f.dir);
    if (group.length < 2 && drop.length === 0) continue; // nothing to do

    if (group.length > 1) mergedFolders++;
    console.log(
      `  ${canonical.f.artist}/${canonical.f.album}/  (${group.length} folder(s), ${allFiles.length} files` +
        `${canonicalTitles ? `, canonical ${canonicalTitles.length}` : ''}) → keep ${keep.length}, drop ${drop.length}`,
    );

    // Move keepers that live in a sibling folder into the canonical one.
    for (const k of foreignKeepers) {
      const src = join(k.dir, k.name);
      const dest = join(canonical.f.dir, k.name);
      console.log(`      move ${k.dir === canonical.f.dir ? '' : basename(k.dir) + '/'}${k.name}`);
      if (apply) {
        try {
          if (existsSync(dest)) unlinkSync(src); // collision — canonical wins
          else renameSync(src, dest);
          appendFileSync(logPath, `MOVE\t${src}\t${dest}\n`, 'utf-8');
        } catch (err) {
          console.log(`        ! move failed: ${String(err)}`);
        }
      }
      filesMoved++;
    }

    // Delete drops.
    for (const d of drop) {
      const p = join(d.dir, d.name);
      console.log(`      drop ${basename(d.dir)}/${d.name}`);
      if (apply) {
        try {
          unlinkSync(p);
          appendFileSync(logPath, `DROP\t${p}\t(${d.size} bytes)\n`, 'utf-8');
          db.run('DELETE FROM completed_downloads WHERE basename = ?', [d.name.toLowerCase()]);
        } catch {
          continue;
        }
      }
      filesDeleted++;
      bytesFreed += d.size;
    }

    // Remove now-empty sibling folders.
    for (const x of withCounts.slice(1)) {
      if (apply) {
        try {
          if (readdirSync(x.f.dir).length === 0) rmdirSync(x.f.dir);
        } catch {
          /* not empty / vanished */
        }
      }
    }
  }

  const mb = (bytesFreed / (1024 * 1024)).toFixed(1);
  console.log(
    `\nDone (${apply ? 'applied' : 'dry run'}). merged-folder-groups=${mergedFolders} moved=${filesMoved} dropped=${filesDeleted} reclaimed=${mb} MB`,
  );
  if (!apply && (filesMoved > 0 || filesDeleted > 0)) {
    console.log('\nRe-run with --apply to perform these. (Moves/deletes are not reversible.)');
  }
  if (apply) console.log('\nTrigger a Navidrome rescan so the library reconciles.');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
