# Library quality auditor

A single tool that **asserts the library is reliable** across the canonical
`library_*` SQLite tables **and** the music dir on disk — and a matching cleanup
pass + ingest-time prevention so the same defects don't recur.

Born from a real audit of the production library (1,783 albums / 6,842 songs /
777 artists): the aggregate was healthy but the **singles tail was polluted** by
DJ-pool / VA-source rips (one source, `ftpdjemilio.com`, accounted for 212 junk
singles), disk had **533 empty folders**, and **835 albums** were missing a year.
The auditor turns "is the library clean?" into a yes/no with a non-zero exit code.

## The three pieces

| Piece | File | Role |
|-------|------|------|
| **Detect** | `services/library-audit.ts` (DB), `services/library-disk-audit.ts` (disk) | Pure rule functions → `AuditReport`. CI-tested. |
| **Assert** | `scripts/audit-library.ts` | Prod CLI: DB + disk checks, `--json`, **exits non-zero on any HIGH finding** (gate-able). Read-only. |
| **Clean** | `scripts/repair-pollution.ts` | Deletes junk + sweeps empty dirs. **Dry-run unless `--apply`**, logged, mis-split-protected. |
| **Re-tag** | `services/library-retag.ts` + `scripts/retag-pollution.ts` | Recovers mis-tagged **real** music (the cleanup keeps) into correct artist/album. **Dry-run unless `--apply`**, reversible. |
| **Prevent** | `services/library-quality.ts` predicates wired into `library-organizer.ts` + `library-curator.ts` | Reject/auto-hide pollution at ingest so new patterns can't re-mint. |

The shared predicates (`looksLikeSourceWatermark`, `isNumericLikeName` in
`library-quality.ts`) are the **single source of truth** reused by both detection
and prevention, alongside the existing `isUnknownLike` (audio-tags) /
`isPlaceholderArtist` (artwork-backfill) / `normalizeForGrouping` (album-grouping).

## Rule catalogue

Each finding has a `rule`, `severity` (`high`/`medium`/`low`), `subject` (id/name/path)
and a message. The CLI groups by rule (worst first); `--rule=<id>` lists one.

### Integrity (high)
- `album_count_mismatch` — `library_artists.album_count` ≠ actual album count.
- `album_song_count_mismatch` — `library_albums.song_count` ≠ actual song count.
- `dangling_album_artist` / `dangling_song_album` — a row references a missing parent.
- `orphan_artist` (medium) — an artist with zero albums and zero songs (should be pruned).

### Pollution (high; detection is **hidden-agnostic** — junk is junk even if the curator hid it)
- `watermark_artist` — artist name is a DJ-pool/VA-source watermark (`ftpdjemilio.com`,
  `Batea Especial…`). The distinct artist row often owns hundreds of junk singles.
- `numeric_artist` — artist name is a bare/disc-track number (`101`–`208`): a mis-parsed tag.
- `watermark_album` — album title is a source watermark (a **real** artist with the
  source in the album field, e.g. UMEK / `MUSICAUNO.COM`).
- `numeric_single` — a one-track album titled a bare number (`07`).
- `placeholder_single` (medium) — a single whose identity is unknown/placeholder.
- `missplit_album` — ≥3 one-track singles share an edition-stripped title: a real
  album fragmented per-track (an opera tagged with numeric per-track artists), or a
  real VA compilation. **These hold wanted music — re-merge, don't delete.**

### Render (low/medium; **visible albums only**)
- `missing_year` (low) — no usable year.
- `missing_artwork` (medium) — no `library_artwork` row and no embedded/folder cover.
- `visible_unknown` (medium) — a visible album stuck at `classification='unknown'`.

### Disk (from `library-disk-audit.ts`)
- `missing_file` (high) — a `library_songs.path` with no file on disk (stale row).
- `orphan_file` (medium) — an audio file on disk with no DB row. **Expected in part**:
  the scanner keeps one best file per track, so deluxe/alt-format extras on disk are
  legitimately not DB rows — review before deleting.
- `empty_dir` (low) — a directory with no entries (leftover folder, safe to `rmdir`).

## Usage

```bash
# Assert (read-only; exits 1 if any HIGH finding)
bun run packages/api/src/scripts/audit-library.ts
bun run packages/api/src/scripts/audit-library.ts --json
bun run packages/api/src/scripts/audit-library.ts --rule=watermark_artist
bun run packages/api/src/scripts/audit-library.ts --no-fail   # report but always exit 0

# Clean (DRY-RUN by default — review, then --apply)
bun run packages/api/src/scripts/repair-pollution.ts                 # default rules: watermark_artist
bun run packages/api/src/scripts/repair-pollution.ts --rules=all --empty-dirs
bun run packages/api/src/scripts/repair-pollution.ts --rules=watermark_artist,watermark_album --apply
```

Env: `NICOTIND_DATA_DIR`, `NICOTIND_MUSIC_DIR`, `NICOTIND_CONFIG` (same as the other
maintenance scripts).

### Cleanup safety model
`repair-pollution.ts` **deletes files on disk and their canonical rows**, then prunes
orphaned artists (`pruneOrphanArtist`) and empty folders. It is destructive and
irreversible — every deletion is appended to `<dataDir>/repair-pollution.log`.

- **Deletable rules** (`DELETABLE_RULES`): `watermark_artist`, `watermark_album`,
  `numeric_single`, `placeholder_single`. Default (no `--rules`) is
  `watermark_artist` only — the safest, highest-volume junk.
- **Always protected**: `numeric_artist` and **real-named** `missplit_album` clusters
  (the Piazzolla opera, real VA comps). A mis-split whose shared title is *itself* a
  watermark (`MUSICAUNO.COM`) is **not** protected — it's pure pollution and stays
  deletable. Selection lives in `selectPollutionTargets` (pure, unit-tested).
- Protected real-but-mis-tagged albums should be re-merged with the existing
  `normalize-library` / `repair-album-folders` scripts, not deleted here.

## Re-tagging low-hanging fruit (recover, don't delete)
`scripts/retag-pollution.ts` fixes pollution that is **real music, just mis-tagged** — the
albums the cleanup deliberately keeps — using only data already in the row (no external
lookup). Two patterns (`planRetag`, pure/tested):

- **watermark album, real artist** — `<RealArtist>/MUSICAUNO.COM/<Title>`: the artist is
  correct and only the album field is the watermark → drop it so the track becomes a clean
  single titled by its track name. Skips the *inverted* mis-tag (`DJ KAIRUZ- SERVICIO ARG`
  dumps where the title is itself the watermark and the real name sits in the artist field) —
  those are ambiguous junk left to the `watermark_album` delete path.
- **numeric-artist mis-split with an embedded title** — `101/1968 - Astor Piazzolla - MARÍA
  DE BUENOS AIRES/<Title>`: parse `YYYY - Artist - Album` out of the album title. Every
  fragment re-mints to the same corrected album id and **merges** back into one album.

Each correction goes through the existing `applyMetadataFix`: a **reversible** override in
`library_metadata_overrides` (survives rescans) plus an immediate canonical re-point (merging
collisions, pruning orphan artists). Files are not moved (`songId` stays stable); the on-disk
folder is tidied later by a reorg pass.

```bash
bun run packages/api/src/scripts/retag-pollution.ts           # dry run
bun run packages/api/src/scripts/retag-pollution.ts --apply   # write corrections (logged, reversible)
```

### Year backfill
Two paths, depending on whether a live metadata service is available:

- **Offline** — `scripts/backfill-years.ts` (+ pure `services/year-backfill.ts`) fills years
  with no network, from three local signals, highest-confidence first: the song **tag** year,
  the album **folder**-name year (`parseYearFromFolder` — reliable for comps like "Max Mix 2015"),
  and — opt-in via `--mb-cache` — the release date of the matching recording in the existing
  `mb-cache.json`. The mb-cache mapping often points at a **reissue**, so its year can be a
  reissue date (e.g. "Chocolate Starfish" → 2024 not 2000) — opt-in, logged, reversible; spot-check.
  Each year is written through the reversible `applyMetadataFix` (override + canonical columns),
  so it survives a full rescan even when the file tag has no year.
  ```bash
  bun run packages/api/src/scripts/backfill-years.ts --apply             # tag+folder (high-confidence)
  bun run packages/api/src/scripts/backfill-years.ts --mb-cache --apply  # + mb-cache (reissue caveat)
  ```
- **Online** — the existing **metadata-optimize** pass (`scripts/optimize-metadata.ts` / admin
  `POST /api/admin/metadata-optimize`) re-fetches year/cover/type from a live Lidarr — the highest
  accuracy, when Lidarr is configured. See [metadata-optimize.md](metadata-optimize.md).

## Prevention (so new patterns can't recur)
- `sanitizeArtistTag` / `sanitizeAlbumTag` (`library-organizer.ts`) now reject
  `looksLikeSourceWatermark` values at ingest, so a watermark never mints an artist/album.
- `LibraryCurator.classify` auto-hides watermark artists/albums and bare-number artists
  on every scan, so pollution that predates the ingest guard disappears from the UI
  without deleting files (the cleanup pass still finds and removes it from disk/DB).

## Production run (2026-06-22)
Initial audit — 777 artists · 1783 albums · 6842 songs · 1040 visible singles; 101 HIGH:
`watermark_album 66 · numeric_artist 15 · missplit_album 10 · missing_file 6 · watermark_artist 2
(owns 222 albums) · album_count_mismatch 1 · numeric_single 1`; `orphan_file 577 · missing_year 835 ·
empty_dir 533`.

Actions taken:
1. **`repair-pollution --rules=watermark_artist --empty-dirs --apply`** — deleted the
   `ftpdjemilio.com`/`Batea` dump (222 albums / 2.3 GiB) and swept 533 empty dirs. (DB backed up first.)
2. **`retag-pollution --apply`** — recovered 31 watermark-album singles to their real artists
   (CID, UMEK, RÜFÜS DU SOL…) and merged the 15-fragment **Astor Piazzolla — María de Buenos
   Aires** mis-split into one album.

3. **`backfill-years --apply`** (tag+folder, offline) — filled 46 high-confidence years
   (missing-year 633→587). The remaining ~195 are recoverable offline via `--mb-cache` (reissue
   caveat) or accurately via a live Lidarr (`optimize-metadata`).

Result — 759 artists · 1545 albums · 6630 songs; **51 HIGH (from 101)**, `numeric_artist 0`,
`empty_dir 0`. Remaining `watermark_album 35` is the ambiguous `DJ KAIRUZ- SERVICIO ARG` DJ-pool
dump — re-tag can't cleanly recover it; delete via `--rules=watermark_album` if undesired.

## Tests / CI
`library-quality.test.ts`, `library-audit.test.ts`, `library-disk-audit.test.ts`,
and the new `library-curator.test.ts` cases run in the `ci` job
(`bun test packages/api/src`). The pure predicates and `selectPollutionTargets`
mis-split protection are unit-tested directly; the auditor rules and curator
auto-hide use a seeded in-memory `bun:sqlite` DB.

## Follow-up (deferred): BPM / genre at acquisition
On-demand `analyzeBpm` + `verifyGenre` (`track-analysis.ts`) could run in the ingest
pipeline (post-organize, gated on ffmpeg/Lidarr, best-effort/async) to auto-fill
`bpm`/`genre` so genre-browse / categorization improves. Out of the initial auditor
iteration; revisit once the audit/cleanup loop is established.
