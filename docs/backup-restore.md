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

## Portable config export / import (issue #221)

Distinct from the opaque full-DB snapshot above (which VACUUMs the *entire*
database, library index included), the **config export** emits only the small,
human-legible *configuration* a self-hoster would hand-edit or carry between
installs — for painless host migration and disaster recovery without swapping
SQLite files. Implementation: `packages/api/src/services/config-export.ts`;
admin routes in `routes/admin.ts`; Admin → System "Export config / Import
config" block.

### What the artifact contains

A single versioned JSON (`kind: "nicotind-config"`, `version: 1`):

- **`settings`** — every `app_settings` key/value (processing/streaming/download
  prefs, etc.), values parsed from their stored JSON.
- **`plugins`** — one entry per row in the `plugins` table: `id`, `enabled`,
  non-secret `config`, `redactedSecrets` (the keys that were stripped),
  `consentAt`/`consentUser`.

### Secret handling (deliberate — do NOT ship raw secrets in a download)

Plugin credentials (`password`-type manifest config fields) and the JWT/service
secrets in `secrets.json` are **never** written into the exported artifact — a
raw API key inside a file the browser downloads is an exfiltration hazard. The
stripped keys are listed per-plugin as `redactedSecrets` so the import UI can
warn the admin to **re-enter them in Extensions** afterwards. Import is
merge-based (`PluginRegistry.setConfig` unions the imported config over whatever
is already stored), so importing a redacted export onto a host that *already*
holds the secret keeps it. **Including secrets in the export is a documented,
deliberately-unimplemented follow-up** (would need a zip + passphrase-based
encryption and an explicit "I understand" gate); it is out of scope here and the
issue stays open for that half.

### Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/api/admin/config/export` | Download the artifact (secrets redacted); audited `config.export`. |
| POST | `/api/admin/config/import` | Apply an artifact (upsert settings + merge plugin config/enabled); audited `config.import`. `?dryRun=1` (or body `{ dryRun: true }`) returns a "what will change" plan without writing. |

Import is **version-guarded** (rejects an unknown `version`), **shape-validated**
(`ConfigImportError` → 400), **idempotent** (re-importing writes the same
values), and **skips unknown plugin ids** with a warning. The Admin UI reads the
chosen file, fetches the dry-run plan first, shows the change counts + warnings,
and only writes on an explicit "Apply import".
