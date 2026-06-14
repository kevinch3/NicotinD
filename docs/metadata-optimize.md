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
