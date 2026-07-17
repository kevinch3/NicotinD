/**
 * APPEND Lidarr's genres onto the WHOLE library (existing songs included), without
 * clobbering the genres a song already carries — the bulk, on-demand counterpart to
 * the going-forward append in the enrichment `genreTask` and the track-info sheet.
 * Distinct from `backfill-genre.ts`, which only *fills* empty-genre songs and
 * *replaces* their set: this one runs over every song and unions Lidarr's genres in.
 *
 *   bun run packages/api/src/scripts/append-genre-backfill.ts               # dry run
 *   bun run packages/api/src/scripts/append-genre-backfill.ts --apply       # write
 *   bun run packages/api/src/scripts/append-genre-backfill.ts --apply --limit 500
 *
 * Idempotent: `appendSongGenres` dedups case-insensitively, so re-running never
 * duplicates a genre. verifyGenre is artist-scoped, so songs are grouped by artist
 * and looked up **once per artist**. On --apply the merged set is written to
 * `library_song_genres` + the primary column **and** the file tag (so it survives a
 * rescan). `library_genres` facet counts refresh on the next full library scan.
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
import { appendSongGenres, loadGenreSets } from '../services/genre-split.js';

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

function parseLimit(): number | null {
  const i = process.argv.indexOf('--limit');
  if (i === -1) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const limit = parseLimit();
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

  const db = apply
    ? new Database(dbPath, { readwrite: true })
    : new Database(dbPath, { readonly: true });
  if (apply) db.run('PRAGMA busy_timeout = 5000');
  const lidarr = new Lidarr({ baseUrl: lidarrUrl, apiKey: lidarrApiKey });

  const rows = db
    .query<SongRow, []>(
      `SELECT id, path, artist, genre FROM library_songs
       WHERE artist IS NOT NULL AND artist != '' ORDER BY created DESC${limit ? ` LIMIT ${limit}` : ''}`,
    )
    .all();

  console.log(`Mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Lidarr    : ${lidarrUrl}`);
  console.log(`Database  : ${dbPath}`);
  console.log(`Songs     : ${rows.length}${limit ? ` (limited to ${limit})` : ''}\n`);

  // One Lidarr lookup per artist; verifyGenre degrades to null when Lidarr has
  // nothing for the artist, which planGenreBackfill records as a skip.
  const { assignments, skippedArtists } = await planGenreBackfill(rows, async (artist) => {
    const r = await verifyGenre(lidarr, { artist, currentGenre: null });
    return r.suggested;
  });

  // Preview what actually changes: only songs that would GAIN a genre they lack.
  const existingBySong = loadGenreSets(
    db,
    assignments.map((a) => a.song.id),
  );
  let wouldAppend = 0;
  const samples: string[] = [];
  for (const a of assignments) {
    const existing = existingBySong.get(a.song.id) ?? [];
    const seen = new Set(existing.map((g) => g.toLowerCase()));
    const additions = a.genre
      .split(/[;,|]/)
      .map((g) => g.trim().replace(/\s+/g, ' '))
      .filter((g) => g && !seen.has(g.toLowerCase()));
    if (additions.length === 0) continue;
    wouldAppend++;
    if (samples.length < 30)
      samples.push(`  • ${a.artist} — ${a.song.id.slice(0, 8)}  +[${additions.join(', ')}]`);
  }

  console.log(
    `${apply ? 'Appending' : 'Would append'} new genres to ${wouldAppend} songs ` +
      `(${assignments.length} matched, ${skippedArtists.length} artists had no Lidarr genre):\n`,
  );
  for (const s of samples) console.log(s);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to append genres to the DB and file tags.');
    console.log('Note: library_genres facet counts refresh on the next full library scan.\n');
    return;
  }

  const logPath = join(dataDir, 'append-genre-backfill.log');
  let applied = 0;
  for (const a of assignments) {
    const genres = a.genre
      .split(/[;,|]/)
      .map((g) => g.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const before = (existingBySong.get(a.song.id) ?? []).length;
    const merged = appendSongGenres(db, a.song.id, genres);
    if (merged.length === before) continue; // nothing new — skip tag rewrite
    if (musicDir) {
      const abs = resolveSongAbsPath(musicDir, a.song.path);
      if (existsSync(abs)) await writeAudioTags(abs, { genre: merged.join('; ') }).catch(() => false);
    }
    appendFileSync(
      logPath,
      `${new Date().toISOString()}\t${merged.join('; ')}\t${a.artist}\t${a.song.id}\n`,
    );
    applied++;
  }
  console.log(`\n✅ Appended genres to ${applied} songs. Log: ${logPath}`);
  console.log('library_genres facet counts refresh on the next full library scan.\n');
}

if (import.meta.main) {
  await main();
}
