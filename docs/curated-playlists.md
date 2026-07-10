# Curated playlists (system, global, gradient-covered)

Spotify-style curated shelves — "Latin Beats", "2000s Essentials", "Reggae
Roots", "Argentinean Hits", etc. — materialized from the local library and shown
to **every** user. Distinct from user playlists in three ways: they're **global**
(not per-user), **read-only** through the API, and carry a **designed gradient
cover**.

## Data model

The `playlists` table gains two nullable/defaulted columns (migrated via
`try/catch ALTER` in `db.ts`, so existing rows are untouched):

| Column      | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `kind`      | `'user'` (default) or `'curated'`. The **explicit origin marker**.       |
| `cover_art` | Designed gradient cover URL, e.g. `/playlist-covers/latin-beats.svg`.     |

Visibility and mutability are driven by `kind`, **not** ownership:

- **`list()`** returns `WHERE user_id = ? OR kind = 'curated'` — a user sees their
  own playlists plus every curated one. Curated sort first (the "Made for you"
  shelf leads).
- **`get()`** allows `user_id = ? OR kind = 'curated'`.
- **`update()` / `remove()` / `owns()`** all require `kind = 'user'`, so a curated
  playlist is read-only through the per-user API **even to the admin who seeded
  it** (returns 404). Curated playlists are managed only by the seed script.

A curated row still has a non-null `user_id` (the first admin) purely as a
provenance owner — the NOT NULL constraint is satisfied without a table rebuild.

`PlaylistSummary`/`PlaylistDetail` (both API and web `api.service`) expose
`coverArt: string | null` and `kind: 'user' | 'curated'`.

## Covers — designed gradients, committed as static SVGs

`services/playlist-cover.ts` is a **pure, unit-tested** builder
(`playlistCoverSvg({ title, palette })`) producing a diagonal-gradient SVG tile
with the title set large (the `native-icons.ts` pure-builder pattern). SVG, not
raster — crisp at any tile size, tiny, no `sharp`/image pipeline.

`scripts/generate-playlist-covers.ts` writes one `<slug>.svg` per playlist to
`packages/web/public/playlist-covers/` (served by the SPA at
`/playlist-covers/<slug>.svg`). These are **committed assets**; regenerate after
changing a palette/name:

```bash
bun run packages/api/src/scripts/generate-playlist-covers.ts
```

Because the covers are bundled web assets (not API-served cover art), the `<img>`
uses a plain root-relative URL that resolves on both web and native (Capacitor),
so no `apiUrl()` rewrite is needed.

## Definitions + selection

`services/curated-playlists.ts` holds the 15 `CuratedPlaylistDef`s (slug, name,
description, gradient `palette`, a SQL `where` fragment over the `library_songs s`
alias, `targetSize`, `maxPerArtist`) and the pure `selectCuratedTracks()`.

`selectCuratedTracks(rows, { targetSize, maxPerArtist, seed })` makes each broad
genre/era/region bucket a **consumable, ~40-track list**:

- a deterministic seeded shuffle (mulberry32) so re-runs are reproducible;
- a **per-artist cap** so no single act dominates (e.g. Pink Floyd can't eat half
  of "Classic Rock Legends");
- returns **fewer** than `targetSize` when the cap exhausts the distinct-artist
  supply — an honest shorter list rather than padding one artist. (Chile Vibes is
  the deliberate exception: only ~3 Chilean acts are in the library, so its cap is
  generous to fill a balanced 30.)

## Seeding

`scripts/seed-curated-playlists.ts` materializes all 15 for the first admin:

```bash
bun run packages/api/src/scripts/seed-curated-playlists.ts          # dry run (counts only)
bun run packages/api/src/scripts/seed-curated-playlists.ts --apply  # write
```

**Idempotent**: a curated playlist is matched by `(kind='curated', name)`; on
re-apply its songs are replaced and cover/description refreshed. Re-run after the
library grows to refresh the lists in place (no duplicates). Each playlist uses a
slug-derived seed, so its shuffle is stable across runs but differs per playlist.

## Web

The library **Playlists** tab renders two sections (`library.component`):

- **"Made for you"** (`data-testid="curated-playlists"`) — a grid of cover tiles
  (`curated-playlist-tile`), each with the gradient cover, name, song count, and a
  **"Curated"** badge overlay (the explicit origin marker).
- **"Your playlists"** (`data-testid="user-playlists"`) — the create form + the
  user's own playlists, unchanged.

Both are split client-side off the single `list` call via `kind`
(`curatedPlaylists()` / `userPlaylists()` computeds).

The **playlist-detail** page shows the cover (`data-testid="playlist-cover"`), the
description, and — for curated — a `Curated playlist` label
(`data-testid="curated-badge"`) while hiding every mutating control (delete,
Select, per-row remove) via the `isCurated()` computed. Play and offline-download
remain available.

## Tests

- `services/playlist-cover.test.ts` — wrap/escape/SVG builder (palette + title
  present, deterministic); also asserts every `CURATED_PLAYLISTS` **and**
  `RECIPES` slug has a committed `.svg` under `packages/web/public/playlist-covers/`
  — a regression guard, since `cover_art` is set to `/playlist-covers/<slug>.svg`
  unconditionally at materialize time (`auto-playlists.service.ts`) regardless of
  whether the file exists on disk. **Adding a curated def or recipe requires
  re-running `bun run packages/api/src/scripts/generate-playlist-covers.ts` and
  committing the new SVG(s) in the same change**, or the shelf materializes with
  a 404 thumbnail (this happened to the four perceptual-shelf recipes in
  `playlist-recipe.ts`, shipped in a commit that never re-ran the generator).
- `services/curated-playlists.test.ts` — 15 unique defs; `selectCuratedTracks`
  enforces the cap, respects `targetSize`, dedups, degrades gracefully, and is
  seed-deterministic.
- `routes/playlists.test.ts` — curated playlists visible to every user with
  `kind`/`coverArt`, fetchable by any user, and **not** updatable/deletable (404).
