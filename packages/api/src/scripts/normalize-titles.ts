/**
 * Apply `cleanDisplayTitle` to titles ALREADY in the library.
 *
 *   bun run packages/api/src/scripts/normalize-titles.ts              # dry run
 *   bun run packages/api/src/scripts/normalize-titles.ts --apply
 *   bun run packages/api/src/scripts/normalize-titles.ts --apply --limit=50
 *   bun run packages/api/src/scripts/normalize-titles.ts --albums     # album names too
 *
 * Background (issue #775):
 *   `cleanDisplayTitle` only ever ran on the way IN — the organizer at ingest
 *   and the advisory `suggested` field of `lookup_song_metadata`. Nothing
 *   applied it to rows already in `library_songs` / `library_albums`, so every
 *   track that landed before #722, or that was imported rather than organized,
 *   kept its junk title forever. The 2026-08-27 curation pass counted ~100 such
 *   rows fixed by hand one call at a time, plus several hundred remaster labels.
 *
 * How it works:
 *   1. Reads every song title (and with `--albums`, every album name).
 *   2. `planTitleNormalization` keeps only the rows the cleaner actually
 *      rewrites — it is conservative by construction, so "(Remix)", "(En Vivo)"
 *      and the Evanescence-style variants distinguished ONLY by their suffix
 *      are left alone.
 *   3. With `--apply`, each change goes through `mutateSongMetadata` — the SAME
 *      retag path `fix_song_metadata` uses (write tag → rescan → verify), never
 *      a direct UPDATE. A title lives in the file, so a DB-only write would be
 *      reverted by the next scan.
 *
 * Safe by default: dry-run unless `--apply`. Every applied change is appended to
 * <dataDir>/normalize-titles.log.
 *
 * Run this BEFORE any dedupe sweep: normalizing first is what makes
 * "El Sucu Tucu (Official Video) 'The Visitor' Album" and "El Sucu Tucu"
 * comparable at all.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { expandHome } from '@nicotind/core';
import { cleanDisplayTitle } from '../services/title-clean.js';
import { mutateSongMetadata } from '../services/song-metadata-mutate.js';
import { LibraryScanner } from '../services/library-scanner.js';

export interface TitleRow {
  id: string;
  text: string;
}

export interface TitleChange {
  id: string;
  from: string;
  to: string;
  removed: string[];
}

/**
 * The rows `cleanDisplayTitle` actually rewrites. Pure, so the decision of what
 * to touch is unit-testable away from any IO.
 */
export function planTitleNormalization(rows: readonly TitleRow[]): TitleChange[] {
  const out: TitleChange[] = [];
  for (const row of rows) {
    const { cleaned, removed } = cleanDisplayTitle(row.text);
    if (removed.length === 0 || cleaned === row.text) continue;
    out.push({ id: row.id, from: row.text, to: cleaned, removed });
  }
  return out;
}

/**
 * Circuit breaker for the apply loop.
 *
 * A run can cover thousands of songs, and #776 proved that whole CLASSES of
 * write can fail silently and systematically — 407 albums were pinned to a
 * canonical tracklist that vetoed every retag. If something like that is live
 * again, grinding through the rest of the library achieves nothing and buries
 * the signal. But an isolated failure (one missing file, one permission error)
 * must NOT abort an otherwise-good long run.
 *
 * Both halves below are required, and neither fires alone. The floor keeps an
 * isolated failure from aborting a good long run; the majority ratio is what a
 * systematic veto actually looks like — #776 failed EVERY write on a pinned
 * album, not a scattered few.
 *
 * @param failures  writes attempted that did not verify
 * @param attempted writes attempted so far (failures included)
 * @returns true to stop the loop immediately
 */
export function shouldStopAfterFailures(failures: number, attempted: number): boolean {
  return failures >= FAILURE_FLOOR && failures / attempted > FAILURE_RATIO;
}

/** Below this many failures, nothing is systematic enough to abort a run. */
const FAILURE_FLOOR = 5;
/** Above this share of attempts failing, the run has stopped being productive. */
const FAILURE_RATIO = 0.5;

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

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const withAlbums = args.has('--albums');
  const limitRaw = [...args].find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const limit = limitRaw ? Number(limitRaw) : Infinity;

  const { dataDir, musicDir } = loadConfig();
  const db = new Database(join(dataDir, 'nicotind.db'));
  const scanner = new LibraryScanner(musicDir, db);
  const scanIncremental = async (relPaths: string[]): Promise<void> => {
    const dirs = [...new Set(relPaths.map((p) => join(musicDir, p, '..')))];
    await scanner.reconcileAlbums(dirs);
  };

  const songs = db
    .query<{ id: string; title: string }, []>('SELECT id, title FROM library_songs')
    .all();
  const songPlan = planTitleNormalization(songs.map((s) => ({ id: s.id, text: s.title })));

  const albumPlan = withAlbums
    ? planTitleNormalization(
        db
          .query<{ id: string; name: string }, []>('SELECT id, name FROM library_albums')
          .all()
          .map((a) => ({ id: a.id, text: a.name })),
      )
    : [];

  console.log(`songs:  ${songPlan.length} of ${songs.length} would change`);
  if (withAlbums) console.log(`albums: ${albumPlan.length} would change`);

  const chosen = songPlan.slice(0, limit === Infinity ? undefined : limit);
  for (const c of chosen) console.log(`  "${c.from}"\n    -> "${c.to}"   [${c.removed.join(' ')}]`);

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    if (withAlbums && albumPlan.length > 0) {
      console.log('Album names are renamed by retagging their songs; run --apply --albums.');
    }
    db.close();
    return;
  }

  const logPath = join(dataDir, 'normalize-titles.log');
  let applied = 0;
  const failures: Array<{ id: string; to: string; reason: string }> = [];

  for (const c of chosen) {
    const result = await mutateSongMetadata(db, { musicDir, scanIncremental }, c.id, {
      title: c.to,
    });
    if (result.ok && result.verified) {
      applied++;
      appendFileSync(logPath, `${new Date().toISOString()} ${c.id} "${c.from}" -> "${c.to}"\n`);
    } else {
      // #776: a write that did not persist now says so, with the value the row
      // actually holds — this loop must never report a clean run it did not do.
      const reason = result.ok
        ? 'unverified (no read-back)'
        : `${result.error}${result.actual?.title ? ` (row holds "${result.actual.title}")` : ''}`;
      failures.push({ id: c.id, to: c.to, reason });
    }
    if (shouldStopAfterFailures(failures.length, applied + failures.length)) {
      console.error('\nAborting early — too many writes are not landing.');
      break;
    }
  }

  console.log(`\napplied+verified: ${applied}`);
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length}`);
    for (const f of failures.slice(0, 20)) console.error(`  ${f.id}: ${f.reason}`);
  }
  db.close();
  if (failures.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
