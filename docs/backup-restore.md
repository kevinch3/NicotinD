# Backup & restore

Automatic daily backups of NicotinD's stateful core, modeled on Home
Assistant's built-in backup feature scoped to what actually needs saving.
Implementation: `packages/api/src/services/backup.ts`; admin endpoints in
`routes/admin.ts`; Admin-panel "Back up now" block.

## What a backup contains

`<dataDir>/backups/nicotind-<YYYYMMDD-HHmmss>/`:

- `nicotind.db` — an online snapshot of the SQLite database taken with
  `VACUUM INTO`, which is safe under WAL with concurrent writers and produces
  a compact, self-contained file (no `-wal`/`-shm` sidecars to copy).
- `secrets.json` — the auto-generated slskd/Lidarr/JWT secrets (when present).

**Music files are deliberately excluded** — they're plain files on disk;
rsync/snapshot them with whatever the host already uses. Cover cache and
artist overrides are also excluded (cover cache is re-derivable; artist
overrides are small but re-uploadable — folding them in is a possible
extension).

## Scheduling & retention

- The daily guard `maybeRunDailyBackup` is driven from the windowed
  processor's tick (same pattern as the weekly auto-playlists refresh),
  **before** the enabled/window checks — so backups never depend on library
  enrichment being turned on.
- At most one backup per calendar day, taken at the first tick at/after
  **04:00 local** (a server booted later in the day backs up right away). The
  guard is a `library_sync_state` marker (`backup_last_day`), so restarts
  can't double-run it, and a failure is retried on the next tick.
- After every backup the set is pruned to the newest **7** (only directories
  matching the backup name pattern are ever deleted).
- The snapshot runs synchronously on the tick (bun:sqlite is synchronous);
  for typical library DBs this is well under a second, once a day.

## Configuration

Environment variables (see `.env.example`):

- `NICOTIND_BACKUP=off` — disable scheduled backups (manual trigger still
  works).
- `NICOTIND_BACKUP_KEEP=7` — how many backups to retain.
- `NICOTIND_MIGRATION_BACKUP=off` — migrate without a pre-migration snapshot
  (see below). **Not** implied by `NICOTIND_BACKUP=off`.
- `NICOTIND_MIGRATION_BACKUP_KEEP=3` — how many pre-migration snapshots to keep.

## Pre-migration snapshots (issue #612)

A schema migration is irreversible: there is no down-migration machinery by
design, and the restore path is a manual file swap. `applySchema` is now atomic
(a crash rolls back cleanly), but a transaction cannot help with a migration
that *succeeds and is wrong* — a bad `INSERT ... SELECT` column list in a table
rebuild commits happily. That residual risk is what this snapshot covers.

It lives in `packages/api/src/services/migration-backup.ts`; `migrationBackupHook` is a shared
factory because `initDatabase` is not the only caller of `applySchema`.

It is a different thing from the daily backup, and differs on every axis:

| | Daily backup | Pre-migration snapshot |
|---|---|---|
| When | once per calendar day, ≥04:00 | only when `user_version` is about to advance |
| Where | `<dataDir>/backups/nicotind-<stamp>/` | `<dataDir>/backups/pre-migrate/v<from>-to-v<to>-<stamp>/` |
| Keep | `NICOTIND_BACKUP_KEEP` (7) | `NICOTIND_MIGRATION_BACKUP_KEEP` (3) |
| Off switch | `NICOTIND_BACKUP=off` | `NICOTIND_MIGRATION_BACKUP=off` |
| On failure | logged, tick continues | **throws — the migration is aborted** |

Notes on the choices, because several are deliberate and non-obvious:

- **A fresh install is skipped.** A brand-new database is at version 0 exactly
  like a legacy one, so without an explicit check every new deployment — and
  every e2e run and throwaway container — would snapshot an empty file on its
  first boot. `hasSomethingToLose` gates on the database holding any table.
- **It runs only when the version will actually advance.** On a stamped host
  every restart would otherwise copy the whole database — 170 MB on the
  reference deployment — to protect a migration that is not going to run.
- **`NICOTIND_BACKUP=off` does not suppress it.** That flag means "stop filling
  my disk with daily snapshots". This is a safety net for an irreversible
  operation that happens at most once per version bump, so it gets its own
  switch rather than inheriting one whose meaning does not fit.
- **A failure aborts the boot.** The alternative is running an irreversible
  migration with no net, on someone else's data. A failed boot is recoverable
  (free some space, restart); a bad migration without a snapshot is not. The
  error names `NICOTIND_MIGRATION_BACKUP=off` so an operator can make that call
  explicitly rather than have it made for them. A disk preflight runs first, so
  a full disk reads as "need ~N MB free" rather than a partial file and a
  mid-`VACUUM` `ENOSPC`. Unknown free space is treated as "proceed", never as
  "full".
- **It lives in a subdirectory, which keeps it out of the daily rotation for
  free.** `listBackups` filters on `/^nicotind-\d{8}-\d{6}$/`, so `pre-migrate/`
  is invisible to it and therefore to `pruneBackups`. Otherwise a snapshot would
  evict a daily backup *and* rotate out 7 days later — the opposite of what an
  upgrade net needs, since a bad upgrade may not be noticed for weeks.
- **A name collision suffixes; it never deletes.** The daily backup `rmSync`s
  its target directory first, so two runs in the same second silently destroy
  one another (`stampFor` is second-resolution). Deleting a backup to make room
  for a backup is never right.
- **Every migration path is hooked, and a test enforces it.** `initDatabase` is
  not the only caller: `seed-curated-playlists.ts` and `refresh-auto-playlists.ts`
  both run `applySchema` against the live database. Hooking only `initDatabase`
  would have reproduced the #457/#606 shape — a narrow entry point that silently
  misses the others — so `migrationBackupHook` is a shared factory and a test
  asserts every non-test `applySchema(` call site passes it.
- **The hook runs outside the transaction, and must.** SQLite refuses
  `VACUUM INTO` from within one.

## Admin surface

- `GET /api/admin/backups` — list (name, createdAt, sizeBytes, files),
  newest first.
- `POST /api/admin/backups` — take a backup now (also prunes). Surfaced as
  the **"Back up now"** button in Admin → System, with the existing backups
  listed beneath it, and a **"Last backup"** line above them (or a warning when
  none has ever completed — the API had shipped that summary all along and
  nothing rendered it, so a silently-stopped backup was invisible).

## Restore (manual by design)

The server can't safely swap its own live database out from under itself, so
restore is a documented manual step:

1. Stop the server (`docker compose stop nicotind`).
2. In the data dir (volume `nicotind-data`, `/data/nicotind` in Docker), copy
   the chosen backup's files back:
   `cp backups/nicotind-<stamp>/nicotind.db nicotind.db` (and `secrets.json`
   alongside if you need it — restoring secrets logs every client out and
   re-pairs slskd/Lidarr credentials).
3. Delete any stale `nicotind.db-wal` / `nicotind.db-shm` left from the old
   database.
4. Start the server again. Schema migrations run forward automatically if the
   backup came from an older version.

Off-host safety: the backups directory lives inside the data volume — copy
it somewhere else (rsync/restic/etc.) if you want protection against disk
loss, not just bad upgrades. The 3-2-1 rule applies as everywhere.
