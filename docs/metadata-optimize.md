# Metadata Optimization

Soulseek/URL rips routinely land with missing, wrong, or low-quality cover art and no reliable year. **Metadata optimization** re-fetches better metadata from Lidarr/MusicBrainz and **overwrites** what's stored.

This is deliberately distinct from `backfill-artwork.ts`, which only fills artwork that is *missing*. Optimization is the "this thumbnail is wrong/ugly — fix it" path, so on a confident match it **replaces** the existing cover.

## Service (`services/metadata-optimize.ts`)

`optimizeAlbum(db, lidarr, albumId, { apply, coverCacheDir })`:

1. reads the `library_albums` row; skips junk groupings (`looksLikeNonAlbum` — Singles / Various Artists / Unknown, shared from `artwork-backfill.ts`);
2. runs `lidarr.album.lookup("<artist> <title>")` and matches by normalized title + artist (`normalizeForGrouping` / `normalizeName`);
3. on a match, overwrites:
   - **cover** — `pickAlbumCover(match.images)` → `setArtwork()` (which purges the stale `c_<id>` cover-cache entry so the new image is served immediately);
   - **year** — parsed from `match.releaseDate`, ignoring the `0001`/implausible placeholders MusicBrainz emits, written to `library_albums.year`;
   - **release type** — `mapLidarrAlbumType(match.albumType)` → `setReleaseType()` (`library_release_meta`, the curator's authoritative source).
4. fills **missing track numbers** from the canonical tracklist (`fillTrackNumbers`, issue #694).

Returns `{ matched, coverUpdated, yearUpdated, releaseTypeUpdated, tracksNumbered }`. `apply: false` reports without writing.

### Track numbers (issue #694)

Nothing wrote `library_songs.track` after the scan: the scanner reads `common.track.no` from tags and has no fallback, so a source that omits TRACKNUMBER — yt-dlp, i.e. every YT Music download — left the whole album at NULL forever and its running order arbitrary. Prod: **1,113 songs across 776 albums** (of 15,941), 718 of them fully unnumbered.

Three rules, all deliberate:

- **Only fills NULLs.** A number from the file's own tags, or from a curator, is better evidence than a title match and is never overwritten.
- **All-or-nothing per album** (`TRACK_MATCH_FLOOR`, 0.6). If fewer than 60% of the album's un-numbered songs appear in the canonical tracklist, the local folder is not that release (a bootleg, a mixtape, a mis-grouped folder) and *none* are numbered — interleaving a couple of real positions with NULLs is worse than leaving it unnumbered, because the player sorts on the column.
- **Quiet no-op when the release isn't in Lidarr's library.** `track?albumId=` is the *library* endpoint; an un-provisioned `album.lookup` hit carries no `id` (verified against prod: the top hit for a known artist has a real id and returns the tracklist, later release-group hits have none). Provisioning an artist just to number tracks would be a far bigger action than the repair warrants.

Title matching reuses `normalizeForGrouping` — the same diacritic-folding normalizer used for the album title above — rather than a local copy, so "Canción" folds instead of being mangled (cf. #662).

`optimizeAllAlbums(db, lidarr, opts)` iterates albums (one `album.lookup` each) and aggregates the per-album results. `onlyMissingOrPoor` (default **true**) restricts to albums with no canonical artwork, no year, **or any un-numbered song** — the ones most likely wrong/empty — so a routine run stays cheap; pass `false`/`--all` to re-verify everything. The track-number clause is load-bearing: a yt-dlp album often *does* have a year and a cover, so without it the albums that need the repair most would never be selected (on prod it widens the candidate set 2,623 → 2,719). `limit`/`afterId` bound and resume the walk, `shouldStop()` cancels between albums, and `onProgress` reports cumulatively — see "Running it in the background" below.

Album-keyed stores (`library_artwork`, `library_release_meta`) are keyed on the tag-derived `albumId`, so these writes survive full rescans.

## Surfaces

- **Per-album (admin)** — `POST /api/library/albums/:id/optimize-metadata` (`routes/library.ts`, gated on `lidarr`; `503` unconfigured, `404` on no confident match). The web album-detail page shows an **Optimize metadata** button (admin only) that calls it, re-fetches the album for an updated year, and bumps a `coverBust` signal appended to the cover URL (`&v=N`) so the `<app-cover-art>` re-requests the new image past the browser cache.
- **Bulk (admin)** — `POST /api/admin/metadata-optimize` (`routes/admin.ts`; `?all=1` re-verifies every album, `?dryRun=1` reports only). Returns **202 immediately** and runs in the background; `POST /api/admin/maintenance/cancel` stops it and `GET /api/admin/maintenance/status` (or the `maintenance` slice of `GET /api/admin/review`) reports progress. The web admin **Library Maintenance** section has **Optimize metadata** + **Stop** with a live progress bar.
- **CLI** — `bun run packages/api/src/scripts/optimize-metadata.ts`. Resolves Lidarr URL/key like `backfill-artwork.ts` (env → config → `secrets.json`); this is the bounded *synchronous* path — see [CLI](#cli) below for its flags.

Everything degrades gracefully when Lidarr is unconfigured (`503` / `null`).

## User-driven fix (candidate picker + free-text fallback)

The automatic `optimizeAlbum` matcher is **all-or-nothing**: it requires an exact normalized title+artist match against `lidarr.album.lookup("<artist> <title>")`. That fails badly when the stored artist is itself wrong — e.g. a rip tagged `<Desconocido>` searches `"<Desconocido> Selva"`, which **poisons the query** so a well-known band never matches, and the wrong cover is left in place. Bulk optimize deliberately stays conservative (it's a cheap backfill for *missing* art) and now **skips placeholder-artist albums outright** (`isPlaceholderArtist` — `<Desconocido>`/`Unknown`/`Various Artists`/bracketed names) since it can't safely auto-match them; the **interactive fix** is the answer to "the metadata is just wrong, let me correct it."

### Service (`services/metadata-fix.ts`)

- **`searchCandidates(db, lidarr, albumId, query?)`** — `query` defaults to the album's `"<artist> <album>"`, **but drops the artist and searches by album title alone when the stored artist is a placeholder** (`isPlaceholderArtist`) so `<Desconocido>` searches `"Selva"` (which surfaces La Portuaria) instead of the poisoned `"<Desconocido> Selva"`. The **user can still override** the query (the modal shows an amber hint for placeholder artists, prompting them to type the real artist to narrow results). Returns ranked `MetadataCandidate[]` (`@nicotind/core`) — `pickAlbumCover` for the thumb, `parseYear`, `mapLidarrAlbumType` for the type.
- **`rankCandidates(hits, query)`** (pure) — scores each hit 0–100 by diacritic-folded (`NFD`) query-token overlap and returns the best-first top 8. **Low-confidence hits are kept on purpose** — the user makes the final call, so a weak match is still shown.
- **`applyMetadataFix(db, albumId, { artist?, album?, year?, coverUrl?, releaseType?, source }, { coverCacheDir })`** — applies a user-confirmed correction (from a candidate, or free-text). Persists it in `library_metadata_overrides` so the scanner honors it forever, then mutates the canonical tables to match **immediately** (the exact rows a rescan-with-override would produce):
  - **songs are UPDATEd in place** — `songId` is path-derived and files don't move, so curation (`starred`/`hidden`) and `playlist_songs` references survive untouched; only the denormalized `artist`/`artist_id`/`album_id`/`year` change;
  - the `library_albums` row is moved to the corrected id (or merged if the corrected names collapse onto an existing album), album-keyed side tables (`library_artwork`, `library_release_meta`) are re-pointed, and the corrected artist is upserted while the orphaned old artist is pruned via the shared `pruneOrphanArtist` (`services/library-aggregates.ts`, reused by album-delete);
  - an optional confirmed `coverUrl`/`releaseType` overwrite the art/type.

  Returns the new `albumId`/`artistId` (the web navigates there).

### Override persistence (`services/metadata-override-store.ts`)

`library_metadata_overrides` is keyed on the scanner's **raw** `albumId` (derived from the unchanged on-disk tags), because `resolveTags` always re-derives that id at scan time and looks the override up to substitute the corrected `artist`/`album`/`year` *before* minting `artistId`/`albumId`. To avoid an orphaned row when a user re-corrects an already-corrected album, the row also stores `corrected_album_id` (= `albumIdFor(correctedArtist, correctedAlbum)`); `applyMetadataFix` reverse-resolves the raw row via `findByCorrectedId` and updates it in place. Same side-table philosophy as `library_artwork`/`library_release_meta`: **no files moved, survives full rescans.**

### Surfaces

- **`GET /api/library/albums/:id/metadata-candidates?q=`** (admin; `503` without Lidarr) and **`POST /api/library/albums/:id/metadata`** (admin; **no** Lidarr needed — free-text works offline). The album-detail **"Fix metadata"** button (admin, `data-testid="optimize-metadata"`) opens `MetadataFixModalComponent`: an editable search → candidate cards (cover / artist — title (year) [type] / confidence %) with **Apply**, plus a collapsed **"Enter manually"** fallback (artist/album/year). On apply the page re-fetches the corrected album (by the returned id) and cache-busts the cover.

## Cover picker (change just the artwork)

The candidate "Apply" above always set artist+album+year+cover **together**, and only ever carried the *single* cover Lidarr's top match happened to have — so a wrong/stale cover got stuck. The Fix-metadata modal's top **Cover section** (`data-testid="cover-picker"`) is the cover-only escape hatch.

### Sources (`services/cover-sources.ts`, pure + injectable)

- `dedupeCoverUrls(urls)` — first-seen-order dedupe of Lidarr cover URLs.
- `hashBytes(data)` — FNV-1a fold (length + 32-bit hash) used to collapse identical embedded images.
- `selectDistinctEmbeddedCovers(songs, extract, limit=8)` — one entry per *distinct* image across the album's tracks; `extract` is injected so tests don't touch disk.
- `extractEmbeddedPicture(absPath, loadMM?)` — embedded picture **only** (no folder-art fallback); the cover route's `extractCover` now delegates its embedded branch here.
- `writeFolderCover(albumDir, pic)` — writes `cover.<ext>` (the folder-art name the cover route prefers).

### Endpoints (admin)

- **`GET /api/library/albums/:id/cover-candidates?q=`** → `CoverCandidatesResponse { current, lidarr[], files[] }`:
  - `current` — `{ source:'current', url:'/api/cover/<id>' }`, always present.
  - `lidarr` — deduped alternatives from `searchCandidates` (each `{ url, label:"<title> (<year>)" }`); **omitted, not `503`,** when Lidarr is unconfigured/down.
  - `files` — one `{ source:'file', songId, url:'/api/cover/<songId>?embedded=1' }` per distinct embedded image (empty when no music dir / no art).
- **`POST /api/library/albums/:id/cover`** (`ApplyCoverRequest`): exactly one of —
  - `coverUrl` (Lidarr alt **or** a pasted custom URL) → `setArtwork(db, id, 'album', url, coverCacheDir)`.
  - `songId` (an album track) → `extractEmbeddedPicture` → `writeFolderCover(dirname)` → **`deleteArtwork` (clears the canonical override) + `purgeDiskArtCache`** so the cover route falls back to the new folder image. This is also the **revert-to-original** path: pick a track whose embedded art is the original to undo a bad canonical cover.
  - Both branches, plus `applyMetadataFix`'s `coverUrl` path and `optimizeAlbum`'s Lidarr-match cover write, call `clearCoverNegativeCache(id)` (`routes/streaming.js`) after the write. **Why:** an album with no art yet gets its id memoized in the cover route's `noArtCache` (10 min TTL, see [library-scanner.md](library-scanner.md)) the first time `/api/cover/:id` 404s; every album-cover writer must invalidate that entry for its id or the picked cover silently never appears — not even on a page refresh — until the TTL expires (regression: was only wired for the artist-image override paths, not the album ones; regression-tested in `routes/library.cover.test.ts`).
- **`PUT /api/library/albums/:id/cover`** (multipart, field `image`, JPEG/PNG/WebP ≤ 8 MB — same allow-list/cap as the artist-portrait upload, shared as `MAX_IMAGE_UPLOAD_BYTES`): resolves the album's representative track's folder → converts the upload via `resizeCover(bytes, 1200)` (the same sharp cover-fit-square-WebP function thumbnails already use, just requested at 1200px) → `writeFolderCover` + `deleteArtwork` + `purgeDiskArtCache` + `clearCoverNegativeCache`, identical cleanup to the `songId` branch above. 404s if the album has no track files to place a cover next to; 400 if the bytes don't decode as an image.
- Embedded thumbnails are served by the existing cover route with **`?embedded=1`** (skips canonical+folder, caches under a `~emb`-suffixed key) — see [library-scanner.md](library-scanner.md).

### Web

`MetadataFixModalComponent`'s cover grid (`data-testid="cover-option"`) + a custom-URL input (`data-testid="cover-url-input"`/`-apply`) + an **upload button** (`data-testid="cover-upload-button"`/`-file`, hidden `<input type=file>`). The picker seeds a **synthetic "Current"** option in `ngOnInit` so it renders instantly and never blocks on a slow Lidarr lookup; pure mapping lives in `lib/cover-candidates.ts` (`flattenCoverCandidates`/`coverThumbUrl`/`coverCandidateToRequest`/`customCoverToRequest`). All three apply paths (candidate pick, custom URL, file upload) share one private `runCoverApply` that owns the busy-state/error/refresh scaffolding. Applying a cover emits **`coverChanged`** (distinct from `applied`) so album-detail refetches + cache-busts the hero cover **without closing** the modal.

## Running it in the background (issue #622)

`POST /api/admin/metadata-optimize` used to `await optimizeAllAlbums` inside the request handler.
The loop is serial and one `album.lookup` carries `TIMEOUT_LOOKUP_MS` (20s), so the handler's
runtime was `albums × 20s` with **no bound** — minutes to hours in a single HTTP request, with no
progress, no cancel and no partial result. Three slow albums already exceeded `Bun.serve`'s 60s
`idleTimeout`, so the client saw a dead socket while the server kept working.

It is now a job on the shared `MaintenanceService` (`services/maintenance/`), together with the
other two passes of the same shape (`transcode-library`, `library-sync`).

### Why not an `ENRICHMENT_TASK`

The issue suggested "the existing processing scheduler". It doesn't fit, for four reasons:

1. `LibraryProcessingService.runNow()` drains **every** runnable task — there is no per-task
   trigger, so an admin pressing "Optimize metadata" would also kick BPM/key/energy.
2. Registry membership means running unattended in the nightly window. This pass **overwrites**
   covers, years and release types library-wide; it is an operator action, not background hygiene.
3. `EnrichmentTask` is a **per-song** contract — `countPending(db)` and `satisfiedColumnSql` are
   both phrased against `library_songs`. This is per-album.
4. With `onlyMissingOrPoor: false` the candidate set never shrinks, so `countPending` would report a
   permanently non-zero backlog and `runNow()` would spin forever (`batch.applied === 0` is its only
   escape).

The maintenance registry instead **mirrors** `EnrichmentTask`'s vocabulary (`id` / `label` /
`available()` / `run()`) so the operator-triggered registry reads like the unattended one. Each task
owns its own typed params through `parseParams`, so the runner never learns their shape.

### Status is in-memory, on purpose

`LibraryProcessingService` persists its status because its runs are unattended and recurring;
`LibraryImportService` persists because an import is genuinely resumable. Neither applies here:
someone is watching, and every album is an independent idempotent write, so "resume" is "press the
button again" for the price of one indexed SELECT. Persisting would introduce a real failure mode —
a `phase:'running'` row surviving a crash with no process behind it, i.e. a permanently-running UI
and a busy guard that never releases. The tell that this is real: `LibraryProcessingService.snapshot()`
deliberately *overrides* its own persisted phase from `this.busy`, because even the service that
persists doesn't trust it across a restart. Durability lives in the audit row instead.

**Restart contract:** status resets to `idle`, counters are lost, nothing resumes, and no partial
state is corrupt.

### Why the loop stays serial

`album.lookup` is the one Lidarr call that proxies to Lidarr's shared **upstream** metadata server —
that is why it sits in the 20s tier rather than the 10s local one. Fanning out N concurrent proxied
lookups is how you get rate-limited, which is why the two network-facing enrichment tasks cap their
pool at 2. `mapPool` would also be the wrong tool: it is eager and uncancellable, so Stop would still
wait for the whole pool. And the defect was "hours inside one request", not "slow" — 4× faster and
still unbounded would not have fixed it.

### Bounding, isolation and honest counters

- **`limit` goes into the SQL**, with `ORDER BY id` (index-backed — `id` is `TEXT PRIMARY KEY`) and an
  `afterId` cursor. The order is load-bearing: without it two bounded passes re-walk an arbitrary
  head forever. The cursor ships *with* `limit` because under `all=1` the candidate set is not
  self-narrowing, so a bare `limit` gives a scripted caller a bound that lies.
- **Per-album isolation.** The loop body is wrapped; a throwing album increments `failed`, records
  the first message as `errorSample`, and the pass continues. Previously a throw from
  `setArtwork`/`db.run`/`setReleaseType` rejected the whole pass and **discarded every accumulated
  counter**. The `try` deliberately lives in the bulk loop, **not** in `optimizeAlbum` — the
  per-album admin route should keep surfacing a write failure as a 500.
- **The counter no longer lies.** `result.albums` counted rows *selected*, but `optimizeAlbum` skips
  missing rows, `looksLikeNonAlbum` groupings and placeholder artists before any Lidarr call — so the
  number shown to the admin overstated work done. It is replaced by `candidates` (selected),
  `visited` (reached) and `lookedUp` (actually queried). `lookedUp` is set on the lookup's
  `.catch(() => [])` degrade path too: a timed-out lookup still burned the full 20s budget.

### Cancel latency

`shouldStop()` is checked *between* albums, so a Stop pressed during a lookup takes effect within
one album — up to 20s. That is why the phase union has a third member, `cancelling`: without it the
button looks dead and the admin mashes it. Making Stop instant needs an `AbortSignal` threaded into
`lidarr.album.lookup`, which has no signal parameter today — a follow-up.

### Dry run

`apply: false` still performs every lookup, so a dry run costs exactly as much as a real one and
uses the same background job — it can never be a "fast synchronous" mode. It still writes an audit
row (`detail: 'dry-run'`), and the status carries `dryRun` so the UI says "would update" rather than
"updated".

### Migrating a scripted caller

The route answered 200 with the finished counters; it now answers **202** with
`{ ok, started, status }`. 202 is 2xx, so `res.ok` / `raise_for_status()` callers are unaffected —
only an exact `=== 200` check breaks. Poll `GET /api/admin/maintenance/status` until
`phase === 'idle'` and read the same counters from `detail`.

There is deliberately **no HTTP `?wait=1` mode**: with `idleTimeout` at 60s and a 20s lookup budget,
the largest bound that provably fits is *two albums*. That is not a feature, and the next person to
widen it would not know why the cap existed. The bounded synchronous mode lives at the **function**
layer, where the CLI uses it.

## CLI

`bun run packages/api/src/scripts/optimize-metadata.ts` (dry-run default; `--apply`, `--all`) now also
takes `--limit N` and `--after <id>`, and handles `SIGINT` by finishing the current album and printing
the partial summary rather than discarding every counter. It prints `candidates` / `checked` /
`lookedUp` / `failed`, and the cursor to resume from when it stopped early.
