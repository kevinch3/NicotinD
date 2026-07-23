/**
 * Trusted-metadata genre resolution (issue #187 task A1) — propose → review →
 * apply, the same human-gated shape as `reclassify-genres.ts`, writing into
 * `library_genre_overrides` (see `services/genre-overrides.ts`).
 *
 *   bun run packages/api/src/scripts/resolve-genres.ts --propose
 *   bun run packages/api/src/scripts/resolve-genres.ts --propose --limit 50 --out g.json
 *   bun run packages/api/src/scripts/resolve-genres.ts --apply            # promote every pending row
 *   bun run packages/api/src/scripts/resolve-genres.ts --apply g.json     # promote only reviewed rows
 *   bun run packages/api/src/scripts/resolve-genres.ts --status
 *   bun run packages/api/src/scripts/resolve-genres.ts --reject artist "emilia"
 *   bun run packages/api/src/scripts/resolve-genres.ts --reconsider artist "emilia"
 *   bun run packages/api/src/scripts/resolve-genres.ts --revert artist "emilia"
 *
 * Resolution is ALBUM-FIRST. Measured on the prod library 2026-07-23:
 * MusicBrainz artist-level genres covered 2 of 25 sampled artists (~3% of the
 * genre gap) while release-group level covered 8 of 12 — and far more
 * specifically (`chacarera`, `cumbia`, `progressive house` rather than a flat
 * `Latin`). Lidarr is NOT an independent source: its `genres` array is a
 * verbatim proxy of MusicBrainz artist genres.
 *
 * Rows resolved confidently (see `gateArtistResolution` / `gateAlbumResolution`)
 * are written `applied`; anything matched on name alone is written `pending` for
 * review, which is what stops the real "Emilia" false pair (an Argentine artist
 * exact-name-matching a Swedish one) from mislabelling 26 songs. Rejections are
 * sticky so re-running --propose never re-proposes a declined row.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';

import { normalizeArtistForGrouping, albumGroupKey } from '../services/album-grouping.js';
import {
  deleteGenreOverride,
  getGenreOverride,
  upsertGenreOverride,
  type GenreOverrideRow,
  type GenreOverrideScope,
} from '../services/genre-overrides.js';
import {
  gateAlbumResolution,
  gateArtistResolution,
  pickGenres,
} from '../services/genre-resolve.js';
import { getMbid, upsertMbid } from '../services/mbid-store.js';
import { MusicBrainzClient, MB_USER_AGENT } from '../services/musicbrainz-client.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadDataDir(): string {
  let fileConfig: Record<string, unknown> = {};
  try {
    fileConfig = (parse(
      readFileSync(resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml'), 'utf-8'),
    ) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  return expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
}

interface ArtistRow {
  id: string;
  name: string;
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** Artists that own at least one song with no genre — the actual gap, biggest first. */
function artistsNeedingGenre(db: Database, limit: number): ArtistRow[] {
  return db
    .query<ArtistRow, [number]>(
      `SELECT a.id, a.name
         FROM library_artists a
         JOIN library_songs s ON s.album_artist_id = a.id OR s.artist_id = a.id
        WHERE s.landed_at IS NOT NULL AND (s.genre IS NULL OR s.genre = '')
        GROUP BY a.id
        ORDER BY COUNT(*) DESC
        LIMIT ?`,
    )
    .all(limit);
}

function albumTitles(db: Database, artistId: string): Array<{ name: string; artist: string }> {
  return db
    .query<{ name: string; artist: string }, [string]>(
      `SELECT name, artist FROM library_albums WHERE artist_id = ?`,
    )
    .all(artistId);
}

async function propose(db: Database, mb: MusicBrainzClient, limit: number): Promise<void> {
  const artists = artistsNeedingGenre(db, limit);
  console.error(`Resolving ${artists.length} artists (MusicBrainz is rate-limited to 1 req/s)…`);

  const proposals: GenreOverrideRow[] = [];
  for (const artist of artists) {
    const artistKey = normalizeArtistForGrouping(artist.name);

    // Sticky decisions: never re-propose something already decided. This is the
    // whole reason the review queue is a status column rather than a JSON file.
    if (getGenreOverride(db, 'artist', artistKey)) continue;

    let mbid = getMbid(db, 'artist', artistKey)?.mbid ?? null;
    if (!mbid) {
      const hit = await mb.searchArtist(artist.name);
      if (!hit) continue;
      mbid = hit.id;
      upsertMbid(db, {
        scope: 'artist',
        key: artistKey,
        mbid,
        source: 'mb-search',
        confidence: 0.3,
      });
    }

    const albums = albumTitles(db, artist.id);
    const rgs = await mb.getArtistReleaseGroups(mbid);

    // Album scope first — the highest-yield and most specific source.
    for (const album of albums) {
      const albumKey = albumGroupKey(album.artist, album.name);
      if (getGenreOverride(db, 'album', albumKey)) continue;
      const rg = rgs.find(
        (r) =>
          gateAlbumResolution({
            queryArtist: artist.name,
            queryAlbum: album.name,
            candidateArtist: artist.name,
            candidateAlbum: r.title,
          }).status === 'applied',
      );
      if (!rg) continue;
      const genres = pickGenres(rg.genres);
      if (genres.length === 0) continue; // MB has no genres here — not a proposal

      const gate = gateAlbumResolution({
        queryArtist: artist.name,
        queryAlbum: album.name,
        candidateArtist: artist.name,
        candidateAlbum: rg.title,
      });
      proposals.push({
        scope: 'album',
        key: albumKey,
        genres,
        source: 'musicbrainz',
        mbid: rg.id,
        confidence: gate.confidence,
        status: gate.status,
        note: `${album.artist} — ${album.name} → MB "${rg.title}"`,
      });
    }

    // Artist scope as the fallback, gated on album-title corroboration so a
    // same-name-different-artist match cannot auto-apply.
    const artistGenres = pickGenres(await mb.getArtistGenres(mbid));
    if (artistGenres.length > 0) {
      const gate = gateArtistResolution({
        queryName: artist.name,
        candidateName: artist.name,
        libraryAlbumTitles: albums.map((a) => a.name),
        releaseGroupTitles: rgs.map((r) => r.title),
      });
      proposals.push({
        scope: 'artist',
        key: artistKey,
        genres: artistGenres,
        source: 'musicbrainz',
        mbid,
        confidence: gate.confidence,
        status: gate.status,
        note: artist.name,
      });
    }
  }

  for (const p of proposals) upsertGenreOverride(db, p);

  const applied = proposals.filter((p) => p.status === 'applied').length;
  const pending = proposals.length - applied;
  const outFile = argValue('--out');
  if (outFile) {
    writeFileSync(outFile, JSON.stringify(proposals, null, 2));
    console.error(`Wrote ${proposals.length} proposals to ${outFile}.`);
  } else {
    for (const p of proposals) {
      console.log(
        `${p.status.padEnd(7)} ${p.scope.padEnd(6)} ${p.genres.join(';').padEnd(32)} ${p.note ?? ''}`,
      );
    }
  }
  console.error(
    `\n${proposals.length} proposals: ${applied} auto-applied (confident), ${pending} pending review.` +
      `\nReview with --status, then --apply to promote the pending ones.`,
  );
}

function applyPending(db: Database, file: string | null): void {
  if (file) {
    const rows = JSON.parse(readFileSync(file, 'utf-8')) as GenreOverrideRow[];
    for (const r of rows) upsertGenreOverride(db, { ...r, status: 'applied' });
    console.error(`Applied ${rows.length} reviewed rows from ${file}.`);
    return;
  }
  const res = db.run(
    `UPDATE library_genre_overrides SET status = 'applied' WHERE status = 'pending'`,
  );
  console.error(`Promoted ${Number(res.changes ?? 0)} pending rows to applied.`);
}

function status(db: Database): void {
  for (const r of db
    .query<{ status: string; scope: string; n: number }, []>(
      `SELECT status, scope, COUNT(*) n FROM library_genre_overrides GROUP BY status, scope ORDER BY status, scope`,
    )
    .all()) {
    console.log(`${r.status.padEnd(9)} ${r.scope.padEnd(7)} ${r.n}`);
  }
  const pending = db
    .query<{ scope: string; key: string; genres: string; note: string | null }, []>(
      `SELECT scope, key, genres, note FROM library_genre_overrides WHERE status = 'pending' LIMIT 40`,
    )
    .all();
  if (pending.length > 0) {
    console.log('\nPending review:');
    for (const p of pending) {
      console.log(`  ${p.scope.padEnd(6)} ${p.genres.padEnd(32)} ${p.note ?? p.key}`);
    }
  }
}

function setStatus(db: Database, scope: GenreOverrideScope, key: string, next: string): void {
  const res = db.run(`UPDATE library_genre_overrides SET status = ? WHERE scope = ? AND key = ?`, [
    next,
    scope,
    key,
  ]);
  console.error(`${Number(res.changes ?? 0)} row(s) → ${next}.`);
}

async function main(): Promise<void> {
  const dataDir = loadDataDir();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(2);
  }
  const db = new Database(dbPath);

  const args = process.argv;
  if (args.includes('--status')) {
    status(db);
    return;
  }
  for (const [flag, next] of [
    ['--reject', 'rejected'],
    ['--reconsider', 'pending'],
  ] as const) {
    const i = args.indexOf(flag);
    if (i >= 0) {
      setStatus(db, args[i + 1] as GenreOverrideScope, args[i + 2] ?? '', next);
      return;
    }
  }
  const revertIdx = args.indexOf('--revert');
  if (revertIdx >= 0) {
    const removed = deleteGenreOverride(
      db,
      args[revertIdx + 1] as GenreOverrideScope,
      args[revertIdx + 2] ?? '',
    );
    console.error(removed ? 'Removed.' : 'No such override.');
    return;
  }
  if (args.includes('--apply')) {
    applyPending(db, argValue('--apply')?.startsWith('--') ? null : argValue('--apply'));
    return;
  }
  if (args.includes('--propose')) {
    const mb = new MusicBrainzClient(join(dataDir, 'mb-cache.json'), MB_USER_AGENT);
    await propose(db, mb, Number(argValue('--limit') ?? 100));
    return;
  }
  console.error(
    'Usage: resolve-genres.ts --propose [--limit N] [--out f.json] | --apply [f.json] | --status\n' +
      '                        | --reject <scope> <key> | --reconsider <scope> <key> | --revert <scope> <key>',
  );
  process.exit(1);
}

void main();
