# Data integrity, caching & migrations

One section of [the index](../index.md). Entry shape and caps are unchanged and
`bun run check:claude-md` still enforces them here.

- **Library events channel**: every library mutation announces itself from its service on one bus
  (coalesced, seq-stamped, replayable) and `GET /api/library/events` streams it; an open tab
  refreshes lists, covers and the album page without reload, and its pollers slow 4× while
  connected. `libraryEvents`, `LibraryEventsService`, `libraryEventRoutes`.
  → [cache-invalidation.md](../cache-invalidation.md)
- **Additive schema migrations**: `applySchema` runs every boot and must be idempotent;
  `addColumnIfMissing` checks `PRAGMA table_info` so "already there" is a condition and a real
  migration bug throws loudly. Additive columns only; no down-migration path by design.
  → [design-patterns.md](../design-patterns.md)
- **Schema versioning + atomic migration**: `SCHEMA_VERSION` in SQLite's own `PRAGMA user_version`,
  stamped first inside one `db.transaction()`; `mayCarryLegacyShape` retires the destructive
  legacy-shape steps once stamped. A newer-than-binary stamp warns, never refuses.
  → [design-patterns.md](../design-patterns.md)
- **Pre-migration snapshots**: `services/migration-backup.ts` snapshots via `VACUUM INTO` only when
  `user_version` is about to advance, skipping fresh installs via `hasSomethingToLose`, landing
  outside the daily rotation. `migrationBackupHook` is shared because `initDatabase` is not the only
  `applySchema` caller. → [backup-restore.md](../backup-restore.md)
- **Daily backups**: `VACUUM INTO` snapshot + secrets into `<dataDir>/backups`, once per day via a
  marker-guarded processor-tick hook, pruned to newest N. Restore is a documented manual swap.
  → [backup-restore.md](../backup-restore.md)
- **Config export/import (portable, host migration)**: a JSON bundle of the tables whose rows encode a
  human decision or a credential. Columns *and* primary keys read from `PRAGMA table_info` at runtime;
  secrets redacted by default and skipped on update; import is additive-merge only, dry-run-previewed
  through the apply's own code. → [config-export.md](../config-export.md)
- **Orphan side-table pruning**: per-song side tables deliberately have no FK cascade (a rescan
  rebuilds `library_songs` wholesale), so orphans are swept by mark → unmark → sweep on `orphaned_at`
  with a grace period, and only for regenerable tables. `repointOrphanedAcquisitions` runs first.
  → [cache-invalidation.md](../cache-invalidation.md)
- **Playlist membership survives a song-id change**: ids are `sha1(path)`, so any move re-mints one;
  `repointPlaylistsBeforePrune` runs *inside* the prune, before the delete, matching on a unique
  (title, artist, duration) and leaving ambiguity to dangle.
  → [cache-invalidation.md](../cache-invalidation.md)
- **Cover-cache eviction**: `pruneCoverCache` sweeps entity-keyed files whose row is gone, with the
  same grace period; content-addressed keys are never orphans, and a `d_` disk-art image goes once no
  live `.ref` names it.
  → [cache-invalidation.md](../cache-invalidation.md)
- **Cache-invalidation on library mutations**: every write whose handler mutates artists or genres must
  `invalidateLibraryReads()` on success or the cached grid replays the stale list. The full cross-layer
  sweep and the "adding a cache" checklist are catalogued.
  → [cache-invalidation.md](../cache-invalidation.md)
- **Measure prod before building**: `prod-probe.ts` owns read-only prod inspection
  (`--orphans`/`--jobs`/`--transfers`/`--sql`) behind two independent layers — a `{readonly:true}`
  connection and the legible `assertReadOnlySql`, whose ordering is load-bearing. Writes belong on a
  `VACUUM INTO` copy. → [prod-inspection.md](../prod-inspection.md)
