/**
 * Comprehensive library normalization.
 *
 *   bun run packages/api/src/scripts/normalize-library.ts [options]
 *
 * Options:
 *   --dry-run          Print every action without writing anything.
 *   --phase=A          Run only the fast, offline phase (dedup, folder merges).
 *   --phase=B          Run only the MusicBrainz-assisted phase.
 *   --phase=all        Run both (default).
 *   --cache=<path>     MusicBrainz lookup cache file (default: <dataDir>/mb-cache.json).
 *
 * Phase A (fast, no network):
 *   A1. Remove (2) duplicate files where the original already exists.
 *       FLAC always beats MP3; otherwise keep the larger file.
 *   A2. Merge artist folders that differ only in case/accents.
 *       CANONICAL_OVERRIDES map provides definitive answers for known artists;
 *       remaining ambiguous groups are deferred to Phase B.
 *   A3. Merge album folders within an artist that differ only in case/accents.
 *
 * Phase B (rate-limited at ~1 req/s via MusicBrainz API, disk-cached):
 *   B1. Resolve deferred artist folder groups via MB artist search.
 *   B2. Move tracks from <Artist>/Singles/ to their real album using MB
 *       recording search; write mbRecordingId + mbReleaseId to file tags.
 *   B3. Normalize album folder names to MB canonical casing.
 *
 * Every action is written to library_song_provenance in the NicotinD DB so
 * the UI can show a "Track info" history. The DB navidrome_id column is
 * backfilled by NavidromeSyncer after the next library scan.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
  rmdirSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  appendFileSync,
} from 'node:fs';
import { resolve, join, extname, dirname, basename, relative } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { initDatabase } from '../db.js';
import { readAudioTags, writeAudioTags, AUDIO_EXTS } from '../services/audio-tags.js';
import { sanitizeSegment } from '../services/path-sanitize.js';
import { normalizeTagValue } from '../services/audio-tags.js';
import { MusicBrainzClient } from '../services/musicbrainz-client.js';

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PHASE_ARG = (args.find((a) => a.startsWith('--phase='))?.split('=')[1] ?? 'all') as 'A' | 'B' | 'all';
const CACHE_ARG = args.find((a) => a.startsWith('--cache='))?.split('=')[1];
const RUN_A = PHASE_ARG === 'A' || PHASE_ARG === 'all';
const RUN_B = PHASE_ARG === 'B' || PHASE_ARG === 'all';

// ─── Config ───────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadConfig() {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch { /* no config file */ }

  const dataDir = expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
  const musicDirRaw = process.env.NICOTIND_MUSIC_DIR ?? (fileConfig.musicDir as string | undefined);
  if (!musicDirRaw) throw new Error('musicDir not configured');
  const musicDir = expandHome(musicDirRaw);

  return { dataDir, musicDir };
}

// ─── Name normalization ───────────────────────────────────────────────────────

/**
 * Canonical overrides: definitive artist names that don't need MB lookup.
 * Keyed by the normalized (lowercase, accent-stripped) form of the artist name.
 * Add more as you discover them in your library.
 */
const CANONICAL_OVERRIDES: Record<string, string> = {
  'abba': 'ABBA',
  'la oreja de van gogh': 'La Oreja de Van Gogh',
  'the beatles': 'The Beatles',
  'beatles': 'The Beatles',
  'ac dc': 'AC/DC',
  'ac-dc': 'AC/DC',
  'rxpmusic': 'RXPMusic',
};

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Collapse a name to a form suitable for dedup grouping. */
function normalizeName(s: string): string {
  return stripAccents(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── File utilities ───────────────────────────────────────────────────────────

function getFileSize(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}

function isAudioFile(p: string): boolean {
  return AUDIO_EXTS.has(extname(p).toLowerCase());
}

function listDir(d: string): string[] {
  try { return readdirSync(d); } catch { return []; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function moveFile(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') {
      copyFileSync(src, dst);
      unlinkSync(src);
    } else if (code === 'EACCES' || code === 'EPERM') {
      // Files are root-owned (written by Docker). Fix with:
      //   sudo chown -R $USER /path/to/music
      throw Object.assign(new Error(`Permission denied: ${src}\nRun: sudo chown -R $USER ${src.split('/').slice(0, 4).join('/')}`), { code });
    } else throw err;
  }
}

function rmIfEmpty(d: string): void {
  if (!existsSync(d)) return;
  try { rmdirSync(d); } catch { /* not empty */ }
}

function uniqueDst(dst: string): string {
  if (!existsSync(dst)) return dst;
  const ext = extname(dst);
  const stem = dst.slice(0, dst.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const c = `${stem} (${i})${ext}`;
    if (!existsSync(c)) return c;
  }
  return dst;
}

// ─── Counters & logging ───────────────────────────────────────────────────────

const stats = {
  dupsRemoved: 0,
  artistFoldersMerged: 0,
  albumFoldersMerged: 0,
  singlesResolved: 0,
  albumsRenamed: 0,
  errors: 0,
};

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

// ─── Provenance DB ────────────────────────────────────────────────────────────

type ProvenanceAction =
  | 'duplicate_removed'
  | 'artist_folder_merged'
  | 'album_folder_merged'
  | 'moved_from_singles'
  | 'album_renamed';

interface ProvenanceDetail {
  from?: string;
  to?: string;
  kept?: string;
  mb_recording_id?: string;
  mb_release_id?: string;
  mb_album_title?: string;
  mb_artist_name?: string;
  reason?: string;
}

let _db: Database | null = null;

function getDb(): Database | null { return _db; }

function writeProvenance(songPath: string, action: ProvenanceAction, detail: ProvenanceDetail): void {
  const db = getDb();
  if (!db) return;
  try {
    db.run(
      `INSERT INTO library_song_provenance (song_path, action, detail, applied_at)
       VALUES (?, ?, ?, ?)`,
      [songPath, action, JSON.stringify(detail), Date.now()],
    );
  } catch { /* non-fatal */ }
}

// ─── Move log ─────────────────────────────────────────────────────────────────

let moveLogPath: string | null = null;

function logMove(src: string, dst: string): void {
  if (!moveLogPath) return;
  try { appendFileSync(moveLogPath, `${src}\t${dst}\n`, 'utf-8'); } catch { /* non-fatal */ }
}

// ─── Phase A1: Remove (2) duplicates ─────────────────────────────────────────

function phaseA1_removeDups(musicDir: string): void {
  log('\nPhase A1: Removing (2) duplicate files...');

  const stack: string[] = [musicDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of listDir(dir)) {
      const full = join(dir, name);
      if (isDir(full)) { stack.push(full); continue; }
      if (!isFile(full) || !isAudioFile(full)) continue;

      if (!name.includes(' (2)')) continue;

      const ext = extname(name);
      const stem = basename(name, ext);
      const originalStem = stem.replace(/ \(2\)$/, '').replace(/ \(\d+\)$/, '');
      if (originalStem === stem) continue; // no trailing (N) pattern

      // Check all variants: same ext, .flac, .mp3
      const candidates = [
        join(dir, `${originalStem}${ext}`),
        ...(ext.toLowerCase() !== '.flac' ? [join(dir, `${originalStem}.flac`)] : []),
        ...(ext.toLowerCase() !== '.mp3' ? [join(dir, `${originalStem}.mp3`)] : []),
      ];

      const original = candidates.find((c) => existsSync(c));
      if (!original) continue;

      // Decide which to keep
      const origExt = extname(original).toLowerCase();
      const dupExt = ext.toLowerCase();

      let loser: string;
      let winner: string;

      if (origExt === '.flac' && dupExt !== '.flac') {
        // Original is FLAC, dup is lower quality
        loser = full; winner = original;
      } else if (dupExt === '.flac' && origExt !== '.flac') {
        // Dup is FLAC, original is lower quality → keep dup, rename over original
        loser = original; winner = full;
      } else if (getFileSize(original) >= getFileSize(full)) {
        loser = full; winner = original;
      } else {
        loser = original; winner = full;
      }

      log(`  DEL  ${relative(musicDir, loser)}  (keeping ${basename(winner)})`);
      if (!DRY_RUN) {
        if (winner === full) {
          // Dup wins: rename over original
          try { unlinkSync(original); renameSync(full, original); } catch { stats.errors++; }
          writeProvenance(
            relative(musicDir, original),
            'duplicate_removed',
            { from: relative(musicDir, original), kept: relative(musicDir, original), reason: 'dup was higher quality' },
          );
        } else {
          try { unlinkSync(full); } catch { stats.errors++; }
          writeProvenance(
            relative(musicDir, original),
            'duplicate_removed',
            { from: relative(musicDir, full), kept: relative(musicDir, original) },
          );
        }
      }
      stats.dupsRemoved++;
    }
  }
  log(`  → ${stats.dupsRemoved} duplicates removed`);
}

// ─── Phase A0: Merge "Artist - Album" top-level folders ──────────────────────

/**
 * For "Artist - Album" folder names: extract the part before the first " - "
 * and look for an exact normalized match against a known artist folder.
 * Returns the matched artist name or null.
 *
 * Only the dash-separator pattern is used — prefix-only matching (e.g. "Fire"
 * matching "Fire Escape") produces too many false positives with short names.
 */
function findDashPatternArtist(dirName: string, normToArtist: Map<string, string>): string | null {
  const dashIdx = dirName.indexOf(' - ');
  if (dashIdx === -1) return null;
  const prefix = dirName.slice(0, dashIdx).trim();
  return normToArtist.get(normalizeName(prefix)) ?? null;
}

/**
 * Extracts a clean album name from everything after "Artist - " in the folder name.
 * Strips trailing year tags like " (2013)", " - 2013", " [FLAC]".
 *
 *   "Rawayana - Licencia Para Ser Libre (2011)"  → "Licencia Para Ser Libre"
 *   "Soda Stereo - Canción Animal (Remastered)"  → "Canción Animal (Remastered)"
 *   "Soda Stereo 1990 - Canción Animal [CBS]"    → "Canción Animal"
 */
function extractAlbumAfterDash(dirName: string, artistName: string): string {
  const suffix = dirName.slice(dirName.indexOf(' - ') + 3).trim();
  // Strip trailing bare-year or format brackets: " - 2013", " [FLAC 320]"
  const cleaned = suffix
    .replace(/\s*-\s*\d{4}$/, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .trim();
  return cleaned || sanitizeSegment(artistName);
}

function phaseA0_mergeArtistAlbumFolders(musicDir: string): void {
  log('\nPhase A0: Merging "Artist - Album" top-level folders...');

  // Build normalized→canonical map from existing artist folders
  const allDirs = listDir(musicDir).filter((name) => isDir(join(musicDir, name)));
  const normToArtist = new Map<string, string>();
  for (const name of allDirs) {
    normToArtist.set(normalizeName(name), name);
  }

  let resolved = 0;

  for (const dirName of allDirs) {
    const dirPath = join(musicDir, dirName);

    // ── Case 1: completely empty folder → just delete ───────────────────────
    const hasAnyContent = (d: string): boolean => {
      for (const e of listDir(d)) {
        const full = join(d, e);
        if (isFile(full)) return true;
        if (isDir(full) && hasAnyContent(full)) return true;
      }
      return false;
    };

    // Skip the folder itself if it IS a known artist entry for something else
    // (i.e., don't accidentally delete real artist folders that happen to be empty)
    if (!hasAnyContent(dirPath)) {
      // Only delete if the name contains a year/format tag or " - " (clearly not a real artist)
      const looksLikeRelease = / - /.test(dirName) || /[\[(]\d{4}[\])]/.test(dirName);
      if (looksLikeRelease) {
        log(`  RMDIR (empty) ${dirName}/`);
        if (!DRY_RUN) {
          try { rmdirSync(dirPath); } catch { /* not empty or already gone */ }
        }
        resolved++;
      }
      continue;
    }

    // ── Case 2: "Artist - Album" dash pattern ───────────────────────────────
    const owner = findDashPatternArtist(dirName, normToArtist);
    if (!owner || owner === dirName) continue; // no match or self

    const ownerDir = join(musicDir, owner);
    const entries = listDir(dirPath);
    const subDirs = entries.filter((e) => isDir(join(dirPath, e)));
    const files = entries.filter((e) => isFile(join(dirPath, e)) && isAudioFile(join(dirPath, e)));

    if (subDirs.length > 0) {
      // Folder already has Album/tracks structure inside
      for (const albumName of subDirs) {
        const srcAlbum = join(dirPath, albumName);
        const dstAlbum = join(ownerDir, albumName);
        log(`  MERGE ${dirName}/${albumName} → ${owner}/${albumName}`);
        if (!DRY_RUN) {
          mkdirSync(dstAlbum, { recursive: true });
          for (const f of listDir(srcAlbum)) {
            const src = join(srcAlbum, f);
            if (!isFile(src)) continue;
            const dst = uniqueDst(join(dstAlbum, f));
            try { moveFile(src, dst); logMove(src, dst); }
            catch { log(`    SKIP (permission denied): ${f}`); stats.errors++; }
          }
          rmIfEmpty(srcAlbum);
        }
      }
      if (!DRY_RUN) rmIfEmpty(dirPath);
    } else if (files.length > 0) {
      // Files directly in the folder — album name comes from the dash suffix
      const albumName = sanitizeSegment(extractAlbumAfterDash(dirName, owner));
      const dstAlbum = join(ownerDir, albumName);
      log(`  MERGE ${dirName}/ → ${owner}/${albumName}/`);
      if (!DRY_RUN) {
        mkdirSync(dstAlbum, { recursive: true });
        for (const f of files) {
          const src = join(dirPath, f);
          const dst = uniqueDst(join(dstAlbum, f));
          try { moveFile(src, dst); logMove(src, dst); }
          catch { log(`    SKIP (permission denied): ${f}`); stats.errors++; }
        }
        for (const f of listDir(dstAlbum)) {
          const fp = join(dstAlbum, f);
          if (!isFile(fp) || !isAudioFile(fp)) continue;
          writeAudioTags(fp, { artist: owner, albumArtist: owner, album: albumName }).catch(() => { /* non-fatal */ });
          writeProvenance(relative(musicDir, fp), 'artist_folder_merged', { from: dirName, to: `${owner}/${albumName}` });
        }
        rmIfEmpty(dirPath);
      }
    } else {
      // No audio content (non-audio files only) — just clean up
      log(`  RMDIR (no audio) ${dirName}/`);
      if (!DRY_RUN) rmIfEmpty(dirPath);
    }
    resolved++;
  }

  log(`  → ${resolved} misrouted folders resolved`);
  stats.artistFoldersMerged += resolved;
}

// ─── Phase A2 + B1: Merge artist folders ─────────────────────────────────────

interface ArtistGroup {
  normalized: string;
  folders: string[];   // absolute paths
}

function groupArtistFolders(musicDir: string): ArtistGroup[] {
  const byNorm = new Map<string, string[]>();
  for (const name of listDir(musicDir)) {
    const full = join(musicDir, name);
    if (!isDir(full)) continue;
    const key = normalizeName(name);
    const group = byNorm.get(key) ?? [];
    group.push(full);
    byNorm.set(key, group);
  }
  return [...byNorm.entries()]
    .filter(([, folders]) => folders.length > 1)
    .map(([normalized, folders]) => ({ normalized, folders }));
}

function pickCanonical(group: ArtistGroup, mbName: string | null): { canonical: string; others: string[] } | null {
  // Check hard-coded overrides first
  const override = CANONICAL_OVERRIDES[group.normalized];
  if (override) {
    // Find the folder whose name matches the override, or use it as-is
    const match = group.folders.find((f) => basename(f) === override);
    const canonical = match ?? join(dirname(group.folders[0]!), override);
    return { canonical, others: group.folders.filter((f) => f !== canonical) };
  }

  // MB lookup result
  if (mbName) {
    const match = group.folders.find((f) => basename(f) === mbName);
    const canonical = match ?? join(dirname(group.folders[0]!), sanitizeSegment(mbName));
    return { canonical, others: group.folders.filter((f) => f !== canonical) };
  }

  // Fallback: pick the folder with the most files (likely the primary one)
  const sorted = [...group.folders].sort((a, b) => {
    const countA = listDir(a).length;
    const countB = listDir(b).length;
    return countB - countA;
  });
  if (sorted.length < 2) return null;
  return { canonical: sorted[0]!, others: sorted.slice(1) };
}

function mergeArtistFolders(
  musicDir: string,
  canonical: string,
  others: string[],
  mbArtistName: string | null,
): void {
  const canonicalName = basename(canonical);
  if (!existsSync(canonical)) {
    if (!DRY_RUN) mkdirSync(canonical, { recursive: true });
  }

  for (const other of others) {
    if (!existsSync(other)) continue;
    for (const album of listDir(other)) {
      const srcAlbum = join(other, album);
      if (!isDir(srcAlbum)) continue;
      const dstAlbum = join(canonical, album);
      if (!existsSync(dstAlbum)) {
        log(`  MOVE ${relative(musicDir, srcAlbum)} → ${canonicalName}/${album}`);
        if (!DRY_RUN) {
          mkdirSync(dstAlbum, { recursive: true });
          for (const f of listDir(srcAlbum)) {
            const src = join(srcAlbum, f);
            const dst = uniqueDst(join(dstAlbum, f));
            if (isFile(src)) {
        try {
          moveFile(src, dst); logMove(src, dst);
        } catch {
          log(`    SKIP (permission denied): ${basename(src)}`);
          stats.errors++;
        }
      }
          }
          rmIfEmpty(srcAlbum);
        }
      } else {
        // Merge file by file
        for (const f of listDir(srcAlbum)) {
          const src = join(srcAlbum, f);
          if (!isFile(src)) continue;
          const dst = uniqueDst(join(dstAlbum, f));
          log(`    FILE ${f} → ${canonicalName}/${album}/${basename(dst)}`);
          if (!DRY_RUN) {
            try { moveFile(src, dst); logMove(src, dst); }
            catch { log(`    SKIP (permission denied): ${f}`); stats.errors++; }
          }
        }
        if (!DRY_RUN) rmIfEmpty(srcAlbum);
      }
    }
    if (!DRY_RUN) rmIfEmpty(other);
  }

  // Fix artist + albumArtist tags in canonical dir
  if (!DRY_RUN) {
    const artistTagName = mbArtistName ?? canonicalName;
    for (const album of listDir(canonical)) {
      const albumDir = join(canonical, album);
      if (!isDir(albumDir)) continue;
      for (const f of listDir(albumDir)) {
        const fp = join(albumDir, f);
        if (!isFile(fp) || !isAudioFile(fp)) continue;
        writeAudioTags(fp, { artist: artistTagName, albumArtist: artistTagName }).catch(() => { /* non-fatal */ });
        writeProvenance(
          relative(musicDir, fp),
          'artist_folder_merged',
          { from: others.map((o) => basename(o)).join(', '), to: canonicalName, mb_artist_name: mbArtistName ?? undefined },
        );
      }
    }
  }
  stats.artistFoldersMerged += others.length;
}

// ─── Phase A3: Merge album folders within an artist ───────────────────────────

function phaseA3_mergeAlbumFolders(musicDir: string): void {
  log('\nPhase A3: Merging case-variant album folders...');
  for (const artistName of listDir(musicDir)) {
    const artistDir = join(musicDir, artistName);
    if (!isDir(artistDir)) continue;

    const byNorm = new Map<string, string[]>();
    for (const albumName of listDir(artistDir)) {
      const full = join(artistDir, albumName);
      if (!isDir(full)) continue;
      const key = normalizeName(albumName);
      const g = byNorm.get(key) ?? [];
      g.push(full);
      byNorm.set(key, g);
    }

    for (const [, folders] of byNorm) {
      if (folders.length < 2) continue;

      // Pick the one with most files (or the FLAC-dominant one) as canonical
      const ranked = [...folders].sort((a, b) => {
        const aFiles = listDir(a);
        const bFiles = listDir(b);
        const aFlac = aFiles.filter((f) => f.toLowerCase().endsWith('.flac')).length;
        const bFlac = bFiles.filter((f) => f.toLowerCase().endsWith('.flac')).length;
        if (aFlac !== bFlac) return bFlac - aFlac;
        return bFiles.length - aFiles.length;
      });

      const canonical = ranked[0]!;
      const others = ranked.slice(1);

      for (const other of others) {
        log(`  MERGE ${artistName}/${basename(other)} → ${artistName}/${basename(canonical)}`);
        if (!DRY_RUN) {
          for (const f of listDir(other)) {
            const src = join(other, f);
            if (!isFile(src)) continue;
            const dst = uniqueDst(join(canonical, f));
            try { moveFile(src, dst); logMove(src, dst); }
            catch { log(`    SKIP (permission denied): ${f}`); stats.errors++; continue; }
            // Fix album tag
            const albumName = basename(canonical);
            writeAudioTags(dst, { album: albumName }).catch(() => { /* non-fatal */ });
            writeProvenance(
              relative(musicDir, dst),
              'album_folder_merged',
              { from: `${artistName}/${basename(other)}`, to: `${artistName}/${albumName}` },
            );
          }
          rmIfEmpty(other);
        }
        stats.albumFoldersMerged++;
      }
    }
  }
  log(`  → ${stats.albumFoldersMerged} album folders merged`);
}

// ─── Phase B2: Resolve Singles via MusicBrainz ───────────────────────────────

async function phaseB2_resolveSingles(musicDir: string, mb: MusicBrainzClient): Promise<void> {
  log('\nPhase B2: Resolving Singles to real albums via MusicBrainz...');

  for (const artistName of listDir(musicDir)) {
    const singlesDir = join(musicDir, artistName, 'Singles');
    if (!existsSync(singlesDir) || !isDir(singlesDir)) continue;

    for (const fname of listDir(singlesDir)) {
      const fpath = join(singlesDir, fname);
      if (!isFile(fpath) || !isAudioFile(fpath)) continue;

      const tags = await readAudioTags(fpath);
      const artist = normalizeTagValue(tags.albumArtist) ?? normalizeTagValue(tags.artist) ?? artistName;
      const title = normalizeTagValue(tags.title) ?? basename(fname, extname(fname));

      log(`  LOOKUP "${title}" by "${artist}"`);
      const hit = await mb.searchRecording(artist, title);

      if (!hit?.release || hit.release.primaryType !== 'Album') {
        log(`    → no album match, keeping in Singles`);
        continue;
      }

      const albumTitle = hit.release.title;
      const albumDir = join(musicDir, sanitizeSegment(artist), sanitizeSegment(albumTitle));
      const dst = uniqueDst(join(albumDir, fname));

      log(`    → "${albumTitle}" (${hit.release.id})`);
      log(`    MOVE ${fname} → ${artist}/${albumTitle}/`);

      if (!DRY_RUN) {
        mkdirSync(albumDir, { recursive: true });
        try { moveFile(fpath, dst); logMove(fpath, dst); }
        catch { log(`    SKIP (permission denied): ${fname}`); stats.errors++; continue; }
        await writeAudioTags(dst, {
          album: albumTitle,
          albumArtist: artist,
          mbRecordingId: hit.id,
          mbReleaseId: hit.release.id,
        });
        writeProvenance(
          relative(musicDir, dst),
          'moved_from_singles',
          {
            from: relative(musicDir, fpath),
            to: relative(musicDir, dst),
            mb_recording_id: hit.id,
            mb_release_id: hit.release.id,
            mb_album_title: albumTitle,
          },
        );
      }
      stats.singlesResolved++;
    }

    if (!DRY_RUN) rmIfEmpty(singlesDir);
  }
  log(`  → ${stats.singlesResolved} Singles resolved to albums`);
}

// ─── Phase B3: Normalize album names to MB canonical ─────────────────────────

async function phaseB3_normalizeAlbumNames(musicDir: string, mb: MusicBrainzClient): Promise<void> {
  log('\nPhase B3: Normalizing album names via MusicBrainz...');

  for (const artistName of listDir(musicDir)) {
    const artistDir = join(musicDir, artistName);
    if (!isDir(artistDir)) continue;

    for (const albumName of listDir(artistDir)) {
      const albumDir = join(artistDir, albumName);
      if (!isDir(albumDir) || albumName === 'Singles') continue;

      // Check if any file already has an mbReleaseId we can use
      let releaseGroupId: string | null = null;
      for (const f of listDir(albumDir)) {
        const fp = join(albumDir, f);
        if (!isFile(fp) || !isAudioFile(fp)) continue;
        const tags = await readAudioTags(fp);
        if (tags.mbReleaseId) { releaseGroupId = tags.mbReleaseId; break; }
      }

      if (!releaseGroupId) continue;

      const rg = await mb.getReleaseGroup(releaseGroupId);
      if (!rg?.title) continue;

      const canonical = sanitizeSegment(rg.title);
      if (canonical === albumName) continue; // already correct

      const newDir = join(artistDir, canonical);
      if (existsSync(newDir)) continue; // don't clobber

      log(`  RENAME ${artistName}/${albumName} → ${artistName}/${canonical}`);
      if (!DRY_RUN) {
        mkdirSync(newDir, { recursive: true });
        for (const f of listDir(albumDir)) {
          const src = join(albumDir, f);
          if (!isFile(src)) continue;
          const dst = join(newDir, f);
          try { moveFile(src, dst); logMove(src, dst); }
          catch { log(`    SKIP (permission denied): ${f}`); stats.errors++; continue; }
          await writeAudioTags(dst, { album: rg.title });
          writeProvenance(
            relative(musicDir, dst),
            'album_renamed',
            { from: `${artistName}/${albumName}`, to: `${artistName}/${canonical}`, mb_release_id: releaseGroupId },
          );
        }
        rmIfEmpty(albumDir);
      }
      stats.albumsRenamed++;
    }
  }
  log(`  → ${stats.albumsRenamed} album folders renamed to MB canonical`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dataDir, musicDir } = loadConfig();
  moveLogPath = join(dataDir, 'normalize-moves.log');

  log(`Music dir : ${musicDir}`);
  log(`Data dir  : ${dataDir}`);
  log(`Move log  : ${moveLogPath}`);
  log(`Mode      : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}, phase=${PHASE_ARG}`);

  // Open DB (skip if DB not initialized yet — script can run standalone)
  try {
    _db = initDatabase(dataDir);
  } catch {
    log('WARN: Could not open NicotinD DB — provenance will not be written');
  }

  if (RUN_A) {
    // A0: Merge "Artist - Album" misnamed top-level folders
    phaseA0_mergeArtistAlbumFolders(musicDir);

    // A1: Remove (2) duplicates
    phaseA1_removeDups(musicDir);

    // A2: Group and merge artist folders (offline pass)
    log('\nPhase A2: Merging artist folder case/accent variants...');
    const groups = groupArtistFolders(musicDir);
    const deferred: ArtistGroup[] = [];

    for (const group of groups) {
      const picked = pickCanonical(group, null);
      if (!picked) { deferred.push(group); continue; }

      log(`  MERGE ${group.folders.map((f) => basename(f)).join(', ')} → ${basename(picked.canonical)}`);
      if (!DRY_RUN) {
        mergeArtistFolders(musicDir, picked.canonical, picked.others, null);
      } else {
        stats.artistFoldersMerged += picked.others.length;
      }

      if (!DRY_RUN && !existsSync(picked.canonical)) {
        // pickCanonical returned an override name that doesn't exist yet; the merge will create it
      }
    }

    if (deferred.length > 0) {
      log(`  ${deferred.length} groups deferred to Phase B for MB lookup`);
    }
    log(`  → ${stats.artistFoldersMerged} artist folders merged`);

    // A3: Merge album folders
    phaseA3_mergeAlbumFolders(musicDir);

    // Store deferred groups for Phase B to pick up
    if (RUN_B && deferred.length > 0) {
      log('\nPhase B1: Resolving deferred artist groups via MusicBrainz...');
      const cacheFile = CACHE_ARG ?? join(dataDir, 'mb-cache.json');
      const mb = new MusicBrainzClient(cacheFile, 'NicotinD/0.1 (nicotind)');

      for (const group of deferred) {
        const hit = await mb.searchArtist(group.normalized);
        const picked = pickCanonical(group, hit?.name ?? null);
        if (!picked) continue;
        log(`  MERGE ${group.folders.map((f) => basename(f)).join(', ')} → ${basename(picked.canonical)}`);
        if (!DRY_RUN) {
          mergeArtistFolders(musicDir, picked.canonical, picked.others, hit?.name ?? null);
        } else {
          stats.artistFoldersMerged += picked.others.length;
        }
      }
    }
  }

  if (RUN_B) {
    const cacheFile = CACHE_ARG ?? join(dataDir, 'mb-cache.json');
    const mb = new MusicBrainzClient(cacheFile, 'NicotinD/0.1 (nicotind)');

    await phaseB2_resolveSingles(musicDir, mb);
    await phaseB3_normalizeAlbumNames(musicDir, mb);
  }

  log('\n═══════════════════════════════════════════');
  log(`Phase A: ${stats.dupsRemoved} (2)-dups removed, ${stats.artistFoldersMerged} artist/album folders merged, ${stats.albumFoldersMerged} case-variant album folders merged`);
  log(`Phase B: ${stats.singlesResolved} Singles resolved, ${stats.albumsRenamed} albums renamed`);
  if (stats.errors > 0) log(`Errors  : ${stats.errors}`);
  if (DRY_RUN) {
    log('\n(DRY RUN — no files were changed. Re-run without --dry-run to apply.)');
  } else {
    log('\nProvenance written to DB. Restart nicotind or trigger a Navidrome rescan.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
