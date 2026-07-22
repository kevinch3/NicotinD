/**
 * Batch-fill the rights/licence code for the whole library — the bulk
 * counterpart to the per-track "Detect" in the track-info sheet and the
 * background `licence` enrichment task. Resolves each un-licenced song from its
 * own LICENSE/COPYRIGHT tag first (zero network), then a MusicBrainz `license`
 * url-relation (best-effort; MB coverage is sparse, mostly CC releases). On
 * --apply each is written to `library_songs.licence` (+ `licence_source`) AND
 * the file's LICENSE tag (`writeAudioTags`) so it survives a rescan.
 *
 *   bun run packages/api/src/scripts/backfill-licence.ts            # dry run
 *   bun run packages/api/src/scripts/backfill-licence.ts --apply    # write
 *   bun run packages/api/src/scripts/backfill-licence.ts --no-mb    # tags only (no network)
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { LICENCE_LABELS, type LicenceCode } from '@nicotind/core';
import { readAudioTags, writeAudioTags } from '../services/audio-tags.js';
import { resolveSongAbsPath } from '../services/track-backfill.js';
import { MusicBrainzClient, MB_USER_AGENT } from '../services/musicbrainz-client.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

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
  const useMb = !process.argv.includes('--no-mb');
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
  const mb = useMb
    ? new MusicBrainzClient(join(dataDir, 'musicbrainz-cache.json'), MB_USER_AGENT)
    : null;

  const rows = db
    .query<SongRow, []>('SELECT id, path, artist, title FROM library_songs WHERE licence IS NULL')
    .all();

  console.log(`Mode       : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`MusicBrainz: ${mb ? 'on (tags → MB)' : 'off (tags only)'}`);
  console.log(`Database   : ${dbPath}`);
  console.log(`Un-licenced songs: ${rows.length}\n`);

  const logPath = join(dataDir, 'backfill-licence.log');
  const byCode = new Map<string, number>();
  let applied = 0;
  let shown = 0;
  for (const song of rows) {
    const abs = resolveSongAbsPath(musicDir, song.path);
    if (!existsSync(abs)) continue;
    const tags = await readAudioTags(abs).catch(() => null);
    let code: string | null = tags?.licence ?? null;
    let source: 'tag' | 'musicbrainz' = 'tag';
    if (!code && mb) {
      source = 'musicbrainz';
      code = await mb
        .getLicence({
          mbRecordingId: tags?.mbRecordingId,
          mbReleaseId: tags?.mbReleaseId,
          artist: song.artist,
          title: song.title,
        })
        .catch(() => null);
    }
    if (!code) continue;
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
    if (shown++ < 30) {
      const label = LICENCE_LABELS[code as LicenceCode] ?? code;
      console.log(`  • ${song.artist} — ${song.title}  →  ${label}  (${source})`);
    }
    if (apply) {
      db.run('UPDATE library_songs SET licence = ?, licence_source = ? WHERE id = ?', [
        code,
        source,
        song.id,
      ]);
      await writeAudioTags(abs, { licence: code }).catch(() => false);
      appendFileSync(logPath, `${new Date().toISOString()}\t${code}\t${source}\t${song.id}\n`);
      applied++;
    }
  }

  console.log('\nBy licence:');
  for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(LICENCE_LABELS[code as LicenceCode] ?? code).padEnd(30)} ${n}`);
  }
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write licences to the DB and file tags.\n');
    return;
  }
  console.log(`\n✅ Applied licence to ${applied} songs. Log: ${logPath}\n`);
}

if (import.meta.main) {
  await main();
}
