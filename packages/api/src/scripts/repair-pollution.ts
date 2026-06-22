/**
 * Delete DJ-pool / VA-source pollution from the library — the junk surfaced by
 * the auditor (scripts/audit-library.ts). DELETES files on disk **and** their
 * canonical rows, then prunes orphaned artists and empty folders.
 *
 *   bun run packages/api/src/scripts/repair-pollution.ts                 # dry run (default rules)
 *   bun run packages/api/src/scripts/repair-pollution.ts --rules=all     # dry run, all delete rules
 *   bun run packages/api/src/scripts/repair-pollution.ts --rules=watermark_artist,watermark_album
 *   bun run packages/api/src/scripts/repair-pollution.ts --empty-dirs    # also sweep empty folders
 *   bun run packages/api/src/scripts/repair-pollution.ts --apply         # actually delete
 *
 * Delete rules (see docs/library-audit.md):
 *   watermark_artist    artist name is a source watermark (ftpdjemilio.com, Batea…) — deletes ALL its albums
 *   watermark_album     album title is a source watermark (real artist, junk album)
 *   numeric_single      one-track album titled a bare number ("07")
 *   placeholder_single  single with an unknown/placeholder identity
 *
 * Default rule set (no --rules): `watermark_artist` only (the safest, highest-volume junk).
 *
 * SAFETY:
 *   - Dry-run unless `--apply`. Deletions are NOT reversible — review the dry run.
 *   - **Mis-split real albums are always protected** (a real release fragmented into
 *     one-track singles, e.g. an opera tagged with numeric per-track artists). Those
 *     are reported as "needs manual re-merge" and NEVER deleted here — use
 *     normalize-library / repair-album-folders for them.
 *   - Every deletion is appended to <dataDir>/repair-pollution.log.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, existsSync, statSync, unlinkSync, rmdirSync, appendFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { pruneOrphanArtist } from '../services/library-aggregates.js';
import { scanMusicDir } from '../services/library-disk-audit.js';
import {
  auditLibrary,
  selectPollutionTargets,
  DELETABLE_RULES,
  type DeletableRule,
} from '../services/library-audit.js';

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

function parseRules(args: Set<string>): DeletableRule[] {
  const raw = [...args].find((a) => a.startsWith('--rules='))?.slice('--rules='.length);
  if (!raw) return ['watermark_artist'];
  if (raw === 'all') return [...DELETABLE_RULES];
  const chosen = raw.split(',').map((r) => r.trim()) as DeletableRule[];
  const invalid = chosen.filter((r) => !DELETABLE_RULES.includes(r));
  if (invalid.length) {
    console.error(`Unknown rule(s): ${invalid.join(', ')}. Valid: ${DELETABLE_RULES.join(', ')}`);
    process.exit(2);
  }
  return chosen;
}

function bytes(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const sweepEmpty = args.has('--empty-dirs');
  const rules = parseRules(args);

  const { dataDir, musicDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}.`);
    process.exit(2);
  }
  // Dry run opens read-only (safe while the server is running); --apply opens
  // read-write with bun:sqlite's default flags (the explicit `{readonly:false}`
  // form trips SQLITE_MISUSE).
  const db = apply ? new Database(dbPath) : new Database(dbPath, { readonly: true });
  const logPath = join(dataDir, 'repair-pollution.log');
  const log = (line: string): void => {
    if (apply) appendFileSync(logPath, `${new Date().toISOString()}\t${line}\n`);
  };

  console.log(`\nrepair-pollution ${apply ? '(APPLY)' : '(dry run)'} — rules: ${rules.join(', ')}`);
  console.log(`  db=${dbPath}\n  music=${musicDir}\n`);

  const { targets, protectedMisSplit } = selectPollutionTargets(db, rules);

  // Resolve each target's files + size up the deletion.
  let totalFiles = 0;
  let totalBytes = 0;
  const perRule = new Map<string, number>();
  const artistIds = new Set<string>();
  const albumFiles: { albumId: string; artistId: string; label: string; paths: string[] }[] = [];

  for (const t of targets) {
    const paths = db
      .query<{ path: string }, [string]>('SELECT path FROM library_songs WHERE album_id = ?')
      .all(t.albumId)
      .map((r) => r.path);
    let size = 0;
    for (const p of paths) {
      try {
        size += statSync(join(musicDir, p)).size;
      } catch {
        /* already gone */
      }
    }
    totalFiles += paths.length;
    totalBytes += size;
    for (const r of t.rules) perRule.set(r, (perRule.get(r) ?? 0) + 1);
    artistIds.add(t.artistId);
    albumFiles.push({ albumId: t.albumId, artistId: t.artistId, label: `${t.artist} — ${t.name}`, paths });
  }

  console.log(`Targets: ${targets.length} albums · ${totalFiles} files · ${bytes(totalBytes)}`);
  for (const [r, n] of [...perRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${r}`);
  }
  if (protectedMisSplit > 0) {
    console.log(`\n  🛡️  ${protectedMisSplit} album(s) protected as mis-split real releases (NOT deleted).`);
    console.log('     Re-merge those with normalize-library / repair-album-folders.');
  }

  // Show a sample so the dry run is reviewable.
  console.log('\nSample (first 20):');
  for (const a of albumFiles.slice(0, 20)) console.log(`  • ${a.label}  (${a.paths.length} file)`);

  if (apply) {
    const tx = db.transaction(() => {
      for (const a of albumFiles) {
        for (const p of a.paths) {
          try {
            unlinkSync(join(musicDir, p));
          } catch {
            /* already gone */
          }
          db.run('DELETE FROM playlist_songs WHERE song_id IN (SELECT id FROM library_songs WHERE path = ?)', [p]);
          db.run('DELETE FROM acquisitions WHERE relative_path = ?', [p]);
          db.run('DELETE FROM completed_downloads WHERE relative_path = ?', [p]);
          log(`file\t${p}`);
        }
        db.run('DELETE FROM library_songs WHERE album_id = ?', [a.albumId]);
        db.run('DELETE FROM library_albums WHERE id = ?', [a.albumId]);
        db.run('DELETE FROM library_artwork WHERE id = ?', [a.albumId]);
        db.run('DELETE FROM library_release_meta WHERE album_id = ?', [a.albumId]);
        db.run('DELETE FROM library_metadata_overrides WHERE raw_album_id = ? OR corrected_album_id = ?', [
          a.albumId,
          a.albumId,
        ]);
        log(`album\t${a.albumId}\t${a.label}`);
      }
      for (const id of artistIds) pruneOrphanArtist(db, id);
    });
    tx();
    // Prune now-empty folders left by the deletions.
    pruneEmptyDirsFor(albumFiles.map((a) => a.paths).flat(), musicDir, log);
    console.log(`\n✅ Applied. Deleted ${albumFiles.length} albums / ${totalFiles} files. Log: ${logPath}`);
  } else {
    console.log(`\nDry run only. Re-run with --apply to delete. (Add --empty-dirs to also sweep empties.)`);
  }

  // Empty-dir sweep (independent of the pollution deletes).
  if (sweepEmpty) {
    const empties = scanMusicDir(musicDir).emptyDirs;
    console.log(`\nEmpty directories: ${empties.length}`);
    for (const d of empties.slice(0, 20)) console.log(`  • ${d}`);
    if (apply) {
      let removed = 0;
      // Deepest first so a parent emptied by its children is also removed.
      for (const d of [...empties].sort((a, b) => b.split('/').length - a.split('/').length)) {
        try {
          rmdirSync(join(musicDir, d));
          removed++;
          log(`empty-dir\t${d}`);
        } catch {
          /* not empty / gone */
        }
      }
      console.log(`✅ Removed ${removed} empty directories.`);
    } else {
      console.log('  (dry run — re-run with --apply --empty-dirs to remove)');
    }
  }

  // Re-audit headline so the operator sees the effect.
  const after = auditLibrary(db);
  console.log(`\nHigh-severity findings now: ${after.highSeverityCount}`);
}

/** Walk up from each deleted file's folder, rmdir-ing dirs that became empty. */
function pruneEmptyDirsFor(relPaths: string[], musicDir: string, log: (s: string) => void): void {
  const dirs = new Set<string>();
  for (const p of relPaths) {
    let d = dirname(join(musicDir, p));
    // album dir, then artist dir
    dirs.add(d);
    dirs.add(dirname(d));
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if (readdirSync(d).length === 0) {
        rmdirSync(d);
        log(`empty-dir\t${d}`);
      }
    } catch {
      /* keep */
    }
  }
}

main();
