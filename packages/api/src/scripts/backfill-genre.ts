/**
 * Batch-fill missing genre for the whole library — the bulk counterpart to the
 * per-track genre verify/apply in the track-info sheet. Needs a **live Lidarr**
 * (genre comes from the artist's Lidarr/MusicBrainz metadata), like
 * optimize-metadata.ts.
 *
 *   bun run packages/api/src/scripts/backfill-genre.ts              # dry run
 *   bun run packages/api/src/scripts/backfill-genre.ts --apply      # write
 *
 * verifyGenre is artist-scoped, so songs are grouped by artist and looked up
 * **once per artist** (not per song); the suggested genre is fanned out to every
 * one of that artist's songs that has no genre yet. On --apply each is written to
 * `library_songs.genre` **and** the file tag (`writeAudioTags`) so it survives a
 * rescan. The `library_genres` facet counts are NOT recomputed here — they
 * refresh on the next full library scan (matching the per-song genre route).
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG,
 * LIDARR_URL or NICOTIND_LIDARR_URL, LIDARR_API_KEY (falls back to config.lidarr.url
 * and dataDir/secrets.json).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { Lidarr } from '@nicotind/lidarr-client';
import { verifyGenre } from '../services/track-analysis.js';
import { writeAudioTags } from '../services/audio-tags.js';
import { planGenreBackfill, resolveSongAbsPath } from '../services/track-backfill.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadConfig(): {
  dataDir: string;
  musicDir: string | null;
  lidarrUrl: string;
  lidarrApiKey: string;
} {
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
  const lidarrCfg = (fileConfig.lidarr as { url?: string } | undefined) ?? {};
  const lidarrUrl =
    process.env.LIDARR_URL ??
    process.env.NICOTIND_LIDARR_URL ??
    lidarrCfg.url ??
    'http://localhost:8686';

  let lidarrApiKey = process.env.LIDARR_API_KEY ?? '';
  if (!lidarrApiKey) {
    const secretsPath = join(dataDir, 'secrets.json');
    if (existsSync(secretsPath)) {
      try {
        lidarrApiKey = JSON.parse(readFileSync(secretsPath, 'utf-8')).lidarrApiKey ?? '';
      } catch {
        /* ignore */
      }
    }
  }
  return {
    dataDir,
    musicDir: musicDirRaw ? expandHome(musicDirRaw) : null,
    lidarrUrl,
    lidarrApiKey,
  };
}

interface SongRow {
  id: string;
  path: string;
  artist: string;
  genre: string | null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { dataDir, musicDir, lidarrUrl, lidarrApiKey } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(2);
  }
  if (!lidarrApiKey) {
    console.error('Lidarr API key not found. Set LIDARR_API_KEY or run nicotind once with Lidarr.');
    process.exit(2);
  }

  const db = apply ? new Database(dbPath, { readwrite: true }) : new Database(dbPath, { readonly: true });
  if (apply) db.run('PRAGMA busy_timeout = 5000');
  const lidarr = new Lidarr({ baseUrl: lidarrUrl, apiKey: lidarrApiKey });

  const rows = db
    .query<
      SongRow,
      []
    >("SELECT id, path, artist, genre FROM library_songs WHERE genre IS NULL OR genre = ''")
    .all();

  console.log(`Mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Lidarr    : ${lidarrUrl}`);
  console.log(`Database  : ${dbPath}`);
  console.log(`Songs w/o genre: ${rows.length}\n`);

  // One Lidarr lookup per artist; verifyGenre degrades to null when Lidarr has
  // nothing for the artist, which planGenreBackfill records as a skip.
  const { assignments, skippedArtists } = await planGenreBackfill(rows, async (artist) => {
    const r = await verifyGenre(lidarr, { artist, currentGenre: null });
    return r.suggested;
  });

  const byArtist = new Map<string, { genre: string; count: number }>();
  for (const a of assignments) {
    const e = byArtist.get(a.artist) ?? { genre: a.genre, count: 0 };
    e.count++;
    byArtist.set(a.artist, e);
  }

  console.log(
    `${apply ? 'Applying' : 'Would apply'} genres for ${byArtist.size} artists / ${assignments.length} songs ` +
      `(${skippedArtists.length} artists had no Lidarr genre):\n`,
  );
  let shown = 0;
  for (const [artist, { genre, count }] of byArtist) {
    if (shown++ >= 30) break;
    console.log(`  • ${artist}  →  ${genre}  (${count} song${count === 1 ? '' : 's'})`);
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write genres to the DB and file tags.');
    console.log('Note: library_genres facet counts refresh on the next full library scan.\n');
    return;
  }

  const logPath = join(dataDir, 'backfill-genre.log');
  let applied = 0;
  for (const a of assignments) {
    db.run('UPDATE library_songs SET genre = ? WHERE id = ?', [a.genre, a.song.id]);
    if (musicDir) {
      const abs = resolveSongAbsPath(musicDir, a.song.path);
      if (existsSync(abs)) await writeAudioTags(abs, { genre: a.genre }).catch(() => false);
    }
    appendFileSync(logPath, `${new Date().toISOString()}\t${a.genre}\t${a.artist}\t${a.song.id}\n`);
    applied++;
  }
  console.log(`\n✅ Applied genre to ${applied} songs. Log: ${logPath}`);
  console.log('library_genres facet counts refresh on the next full library scan.\n');
}

if (import.meta.main) {
  await main();
}
