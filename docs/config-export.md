# Configuration export / import (issue #221)

A portable, human-legible artifact of everything a self-hoster configured, so moving to a new host
is one download + one upload instead of hand-swapping SQLite files.

**Not a replacement for the daily backup.** The two are deliberately different artifacts:

|              | Daily backup ([backup-restore.md](backup-restore.md)) | Config export (this)                |
| ------------ | ----------------------------------------------------- | ----------------------------------- |
| Contains     | whole SQLite DB + `secrets.json`                      | 14 config tables as JSON            |
| Includes the library index | yes (the bulk of it)                    | no — a rescan rebuilds it           |
| Restore      | manual file swap, server stopped                      | in-app upload, server running       |
| For          | disaster recovery on the same host                    | migrating to a *different* host     |

## What counts as "configuration"

One rule decides membership: **a table is in iff its rows encode a human decision or a credential.**
Anything the scanner rebuilds from disk is out. That yields exactly these sections, in import order
(a section may only reference rows in an earlier one, so a sequential import never writes a dangling
reference):

`app_settings` · `plugins` · `plugin_kv` · `users` · `user_settings` · `playlists` ·
`playlist_songs` · `playlist_visibility` · `watchlist` · `library_genre_aliases` ·
`library_genre_overrides` · `library_artist_aliases` · `library_artist_identity` ·
`library_metadata_overrides`

`users` is included despite the issue's original "user settings" wording: without it,
`user_settings`, `playlists` and `watchlist` all arrive on the new host owned by user ids that
don't exist. Host migration is the point, so the owner rows travel with them.

## Schema-drift tolerance — read the schema, never hardcode it

Both columns *and* primary keys come from `PRAGMA table_info` at runtime.

- **Export** does `SELECT *`, so a migration that adds a column carries it automatically and can
  never silently drop data.
- **Import** reconciles each row against the target's live columns: unknown columns are dropped and
  reported in the plan's `unknownColumns` (a bundle from a newer install still applies, minus the
  fields this server doesn't have), and a section whose table is absent is skipped with a warning
  rather than throwing.
- **The upsert's conflict target is the table's real primary key.** This is not a stylistic choice:
  five of the fourteen have a key that doesn't match the obvious guess —
  `library_genre_overrides` is `(scope, key)` not `(scope, target_id)`, `library_artist_aliases` is
  `alias_norm`, `library_artist_identity` is `artist_key`, `library_metadata_overrides` is
  `raw_album_id`, and `playlist_visibility` is `playlist_id` alone. Hardcoding them produced five
  broken upserts on the first attempt.

`bundleVersion` (currently `1`) gates only the *breaking* case: an import refuses a bundle from a
newer server, but a bundle from an older one is applied through the same reconciliation.

## Secrets are opt-out on the wire, opt-in in the file

`GET /api/admin/config/export` redacts credentials (`plugin_kv.value`, `users.password_hash`) unless
called with `?secrets=1`, so the default download is safe to attach to an issue. The Admin panel has
an "Include credentials" checkbox for the migration case.

Redaction is honoured on the way back in: importing a bundle whose `includesSecrets` is false
**skips the blanked columns on update**, so a redacted bundle can never wipe working credentials on
the target. Without that, exporting-redacted then importing would silently log every user out and
break every plugin.

## Import is additive-merge, and only additive-merge

Existing rows are updated, absent ones created, and **rows the target has that the bundle lacks are
left alone**. Replace-semantics are not offered: importing the wrong bundle would then delete the
target's users and plugin credentials, and there is no undo. The issue's "additive-merge, replace,
or user-chosen per section" question is settled at additive-merge for exactly that reason.

Two safety properties beyond that:

- **Dry-run first.** The Admin flow always previews. `previewImport` and `importConfig` share the
  same reconciliation code path, so the preview cannot disagree with the apply.
- **A row that collides on a *non-key* constraint is skipped, not fatal.** The real case: a bundle
  user whose `username` is already taken by a *different* id on the target collides on the
  `users.username` UNIQUE index, which the `ON CONFLICT (id)` target doesn't cover. That row is
  counted into `skip` with a warning while the other thirteen sections still land. The whole import
  is still one transaction, so a genuine failure applies nothing.

## Routes

| Route                              | Notes                                                        |
| ---------------------------------- | ------------------------------------------------------------ |
| `GET /api/admin/config/export`     | admin; `?secrets=1` opts into credentials; `Content-Disposition: attachment`; audit-logged as `config.export` |
| `POST /api/admin/config/import`    | admin; body `{ bundle, dryRun }`; `dryRun: true` returns the plan and writes nothing (and does **not** audit); apply is audit-logged as `config.import` |

Admin UI: the "Export configuration / Import configuration…" block
(`data-testid="config-panel"`) beside "Back up now". Import renders the plan
(`config-import-preview`) with per-section create/update/skip counts and warnings, behind
Apply/Cancel.

## Known gaps (v1)

- **Artist-image overrides are files**, not rows — `<dataDir>/artist-overrides/*` is not in the JSON
  bundle. A migrated host keeps the `manual_override=1` DB rows but has no image bytes behind them.
  Moving to a zip would fix this and is the natural v2 (the issue lists it as an open question).
- **`secrets.json`** (the JWT signing key) is not included, by deliberate omission: importing it
  would make sessions from the old host valid on the new one. Users log in again after a migration.
- **Per-track curation stored as columns on library tables** (`library_songs.starred`, `licence`,
  `bpm`, lyrics) rides on rows a rescan rebuilds, so it isn't in the config bundle. Those are
  COALESCE-preserved and re-derivable by enrichment; a full DB backup is the tool if you need them
  moved verbatim.
- Plugin changes land in the DB but running plugin instances are constructed at boot, so the UI
  tells the admin to restart the server after an import.
