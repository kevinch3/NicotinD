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

## Admin surface

- `GET /api/admin/backups` — list (name, createdAt, sizeBytes, files),
  newest first.
- `POST /api/admin/backups` — take a backup now (also prunes). Surfaced as
  the **"Back up now"** button in Admin → System, with the existing backups
  listed beneath it.

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
