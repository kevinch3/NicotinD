/**
 * Give recent album jobs the standard edition's tracklist (#1936).
 *
 * Jobs reserved before #1936 stored Lidarr's monitored listing, often a box set, so their cards
 * still count bonus discs as "not offered", and auto-complete would hunt those discs once it is
 * back on. Only a job whose stored list is exactly that monitored listing is rewritten, because
 * that is what the old code wrote. A folder someone picked by hand afterwards stores the standard
 * tracks plus the extras it carries, and is left alone.
 *
 *   bun run packages/api/src/scripts/recompute-job-canonical.ts                    # dry run
 *   bun run packages/api/src/scripts/recompute-job-canonical.ts --apply
 *   … --since-hours=48 --before=2026-11-15T11:40:00Z
 *
 * Env: NICOTIND_DATA_DIR (default ~/.nicotind), NICOTIND_LIDARR_URL, LIDARR_API_KEY.
 */
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { expandHome } from '@nicotind/core';
import { Lidarr } from '../lidarr/index.js';
import type { LidarrAlbumRelease } from '../lidarr/types.js';
import { albumEditions, type TracklistSource } from '../services/standard-edition.js';

export interface CanonicalRecompute {
  jobId: string;
  album: string;
  from: number;
  to: number;
  titles: string[];
}

type Source = TracklistSource & {
  album: { get(albumId: number): Promise<{ releases?: LidarrAlbumRelease[] }> };
};

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/** The album jobs in `[sinceMs, beforeMs)` still carrying a monitored box-set list. */
export async function planCanonicalRecompute(
  db: Database,
  lidarr: Source,
  opts: { sinceMs: number; beforeMs: number },
): Promise<CanonicalRecompute[]> {
  const rows = db
    .query<
      {
        id: string;
        album_title: string | null;
        lidarr_album_id: number;
        canonical_tracks_json: string;
      },
      [number, number]
    >(
      `SELECT id, album_title, lidarr_album_id, canonical_tracks_json FROM acquisition_jobs
        WHERE kind IN ('album-hunt', 'auto-acquire') AND lidarr_album_id IS NOT NULL
          AND canonical_tracks_json IS NOT NULL AND created_at >= ? AND created_at < ?
        ORDER BY created_at`,
    )
    .all(opts.sinceMs, opts.beforeMs);

  const plan: CanonicalRecompute[] = [];
  for (const row of rows) {
    const stored = JSON.parse(row.canonical_tracks_json) as string[];
    let releases: LidarrAlbumRelease[] | undefined;
    try {
      releases = (await lidarr.album.get(row.lidarr_album_id)).releases;
    } catch {
      continue;
    }
    const { standard, full } = await albumEditions(lidarr, row.lidarr_album_id, releases);
    const standardTitles = standard.map((t) => t.title);
    const fullTitles = full.map((t) => t.title);
    if (!sameList(stored, fullTitles) || sameList(stored, standardTitles)) continue;
    plan.push({
      jobId: row.id,
      album: row.album_title ?? `#${row.lidarr_album_id}`,
      from: stored.length,
      to: standardTitles.length,
      titles: standardTitles,
    });
  }
  return plan;
}

export function applyCanonicalRecompute(db: Database, plan: readonly CanonicalRecompute[]): void {
  const update = db.prepare(`UPDATE acquisition_jobs SET canonical_tracks_json = ? WHERE id = ?`);
  db.transaction(() => {
    for (const p of plan) update.run(JSON.stringify(p.titles), p.jobId);
  })();
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const apiKey = process.env.LIDARR_API_KEY ?? '';
  if (!apiKey) {
    console.error('Set LIDARR_API_KEY.');
    process.exit(2);
  }
  const baseUrl =
    process.env.NICOTIND_LIDARR_URL ?? process.env.LIDARR_URL ?? 'http://localhost:8686';
  const dbPath = join(expandHome(process.env.NICOTIND_DATA_DIR ?? '~/.nicotind'), 'nicotind.db');
  const db = new Database(dbPath, apply ? { readwrite: true } : { readonly: true });
  if (apply) db.run('PRAGMA busy_timeout = 5000');

  const beforeArg = arg('before');
  const beforeMs = beforeArg ? new Date(beforeArg).getTime() : Date.now();
  const sinceMs = beforeMs - Number(arg('since-hours') ?? 24) * 3_600_000;
  const plan = await planCanonicalRecompute(db, new Lidarr({ baseUrl, apiKey }), {
    sinceMs,
    beforeMs,
  });

  for (const p of plan) console.log(`${p.jobId}  ${p.album}: ${p.from} → ${p.to}`);
  console.log(`${plan.length} job(s) carry a box-set tracklist.`);
  if (!apply) {
    if (plan.length) console.log('Dry run — re-run with --apply to rewrite them.');
    return;
  }
  applyCanonicalRecompute(db, plan);
  console.log(`Rewrote ${plan.length} job(s).`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
