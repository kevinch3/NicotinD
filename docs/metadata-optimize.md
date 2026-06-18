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

Returns `{ matched, coverUpdated, yearUpdated, releaseTypeUpdated }`. `apply: false` reports without writing.

`optimizeAllAlbums(db, lidarr, { apply, coverCacheDir, onlyMissingOrPoor })` iterates albums (one `album.lookup` each) and aggregates the per-album results. `onlyMissingOrPoor` (default **true**) restricts to albums with no canonical artwork or no year — the ones most likely wrong/empty — so a routine run stays cheap; pass `false`/`--all` to re-verify everything.

Album-keyed stores (`library_artwork`, `library_release_meta`) are keyed on the tag-derived `albumId`, so these writes survive full rescans.

## Surfaces

- **Per-album (admin)** — `POST /api/library/albums/:id/optimize-metadata` (`routes/library.ts`, gated on `lidarr`; `503` unconfigured, `404` on no confident match). The web album-detail page shows an **Optimize metadata** button (admin only) that calls it, re-fetches the album for an updated year, and bumps a `coverBust` signal appended to the cover URL (`&v=N`) so the `<app-cover-art>` re-requests the new image past the browser cache.
- **Bulk (admin)** — `POST /api/admin/metadata-optimize` (`routes/admin.ts`; `?all=1` re-verifies every album, `?dryRun=1` reports only). The web admin **System** section has an **Optimize metadata** button.
- **CLI** — `bun run packages/api/src/scripts/optimize-metadata.ts` (dry-run default; `--apply`, `--all`). Resolves Lidarr URL/key like `backfill-artwork.ts` (env → config → `secrets.json`).

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
