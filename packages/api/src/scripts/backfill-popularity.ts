/**
 * Batch-fill the extrinsic popularity signal for the whole library — the bulk
 * counterpart to the background `popularity` enrichment task (issue #220).
 * Resolves each un-scored song's recording MBID from its own `mbRecordingId`
 * tag, fetches the global listen count from ListenBrainz (batched, no creds),
 * and maps it to a 0–1 scalar via `normalizePopularity`. On --apply each is
 * written to `library_songs.popularity` (+ `popularity_source`). Not mirrored to
 * a file tag — popularity is extrinsic and drifts, so it lives only in the DB.
 *
 *   bun run packages/api/src/scripts/backfill-popularity.ts            # dry run
 *   bun run packages/api/src/scripts/backfill-popularity.ts --apply    # write
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { expandHome } from '@nicotind/core';
import { readAudioTags } from '../services/audio-tags.js';
import { resolveSongAbsPath } from '../services/track-backfill.js';
import { ListenBrainzClient, normalizePopularity } from '../services/listenbrainz-client.js';

function loadConfig(): { dataDir: string; musicDir: string | null } {
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
  return { dataDir, musicDir: musicDirRaw ? expandHome(musicDirRaw) : null };
}

interface SongRow {
  id: string;
  path: string;
  artist: string;
  title: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { dataDir, musicDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(2);
  }
  if (!musicDir) {
    console.error('Music dir not configured. Set NICOTIND_MUSIC_DIR.');
    process.exit(2);
  }

  const db = apply
    ? new Database(dbPath, { readwrite: true })
    : new Database(dbPath, { readonly: true });
  if (apply) db.run('PRAGMA busy_timeout = 5000');
  const lb = new ListenBrainzClient({ cacheFile: join(dataDir, 'listenbrainz-cache.json') });

  const rows = db
    .query<SongRow, []>(
      'SELECT id, path, artist, title FROM library_songs WHERE popularity IS NULL',
    )
    .all();

  console.log(`Mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Database  : ${dbPath}`);
  console.log(`Un-scored songs: ${rows.length}\n`);

  // Resolve recording MBIDs from tags, grouping songs that share one.
  const songsByMbid = new Map<string, SongRow[]>();
  let noMbid = 0;
  for (const song of rows) {
    const abs = resolveSongAbsPath(musicDir, song.path);
    if (!existsSync(abs)) continue;
    const tags = await readAudioTags(abs).catch(() => null);
    const mbid = tags?.mbRecordingId;
    if (!mbid) {
      noMbid++;
      continue;
    }
    const group = songsByMbid.get(mbid);
    if (group) group.push(song);
    else songsByMbid.set(mbid, [song]);
  }

  const mbids = [...songsByMbid.keys()];
  console.log(
    `Recording MBIDs to look up: ${mbids.length} (songs without an MBID tag: ${noMbid})\n`,
  );
  const counts =
    mbids.length > 0 ? await lb.getListenCounts(mbids) : new Map<string, number | null>();

  const logPath = join(dataDir, 'backfill-popularity.log');
  let applied = 0;
  let noData = 0;
  let shown = 0;
  for (const [mbid, songs] of songsByMbid) {
    const count = counts.get(mbid);
    if (count === undefined) continue; // transient — will retry on a later run
    if (count === null) {
      noData += songs.length;
      continue;
    }
    const value = normalizePopularity(count);
    for (const song of songs) {
      if (shown++ < 30) {
        console.log(
          `  • ${song.artist} — ${song.title}  →  ${value.toFixed(2)}  (${count.toLocaleString()} listens)`,
        );
      }
      if (apply) {
        db.run('UPDATE library_songs SET popularity = ?, popularity_source = ? WHERE id = ?', [
          value,
          'listenbrainz',
          song.id,
        ]);
        appendFileSync(
          logPath,
          `${new Date().toISOString()}\t${value.toFixed(4)}\t${count}\t${song.id}\n`,
        );
        applied++;
      }
    }
  }

  console.log(
    `\nScored: ${shown}   ·   No ListenBrainz data: ${noData}   ·   No MBID tag: ${noMbid}`,
  );
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write popularity to the DB.\n');
    return;
  }
  console.log(`\n✅ Applied popularity to ${applied} songs. Log: ${logPath}\n`);
}

if (import.meta.main) {
  await main();
}
