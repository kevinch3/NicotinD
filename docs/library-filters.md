# Standardized library metadata filters

One filter model — `LibraryFilter` in `packages/core/src/types/library-filter.ts` — is shared
by every library list view and by the API's SQL builder. The rule of thumb it implements:
**all available properties on all available views** (the Genres tab is the one exclusion).

## Where it applies

| Surface | Route | Notes |
|---|---|---|
| Albums tab | `GET /api/library/albums` | server-paginated grid |
| Compilations tab | `GET /api/library/compilations` | |
| Singles & EPs tab | `GET /api/library/singles` | |
| Artists tab | `GET /api/library/artists` | with no filter params the query is unchanged (back-compat for existing clients) |
| Artist page → Songs tab | `GET /api/library/artists/:id/songs` | filters apply to the songs directly |
| Library Songs tab | `GET /api/library/songs` | also accepts a transient `q` query param (free-text — see below) |

## Free-text search (`q`) on the songs endpoints

In addition to the `LibraryFilter` grammar above, the songs routes accept a
single separate `q` query parameter for free-text matching:

```
GET /api/library/songs?q=alpha&sort=title&genre=House
```

- **Scope**: server-side `LIKE '%q%' COLLATE NOCASE` across `s.title`,
  `s.artist`, and `a.name` (album title). Empty / whitespace-only `q` is dropped.
- **Escaping**: `%`, `_`, and `\` are escaped in the user's query so a literal
  `%` is a literal match, not a wildcard.
- **Not a `LibraryFilter` field**: `q` is intentionally outside the structured
  filter grammar — it's transient text (a typing burst), not URL-mirrored
  metadata, so it lives only on the request and isn't serialized by
  `serializeLibraryFilter`/`parseLibraryFilter`. The web client wires it
  through `LibraryApiService.getAllSongs(..., { q })` and the Library Songs
  tab's debounced search input (`data-testid="library-songs-search"`).
- Same applies to `/api/library/artists/:id/songs`, where the `Songs` tab on
  artist pages can use the same client-side search.

## Properties & query-param grammar

## Properties & query-param grammar

Filters serialize into flat, human-readable query params (`serializeLibraryFilter` /
`parseLibraryFilter` — lenient: malformed or unknown values are dropped, never a 400,
so hand-edited URLs degrade gracefully).

| Property | Params | Example |
|---|---|---|
| BPM range | `bpmMin`, `bpmMax` | `bpmMin=120&bpmMax=140` |
| Musical key | `key` (comma list of Camelot codes) | `key=8A,9A` |
| Mood | `mood` (comma list from `MOOD_VOCAB`) | `mood=happy,party` |
| Perceptual axes | axis name = comma list of buckets | `energy=low,high&valence=mid` |
| Year range | `yearMin`, `yearMax` | `yearMin=1990&yearMax=1999` |
| Genre | `genre` (repeated param — free text may contain commas). Matches the **full multi-genre set**: the predicate is `(s.genre IN (…) OR EXISTS(… library_song_genres …))`, so a track filed under "Electronic; House" matches a House filter; the primary-column IN keeps pre-first-rescan rows filterable. | `genre=Rock&genre=Hip-Hop` |
| Licence | `licence` (comma list from `LICENCE_VOCAB`). Positive codes → `IN (…)`; the `unknown` bucket → `IS NULL`. **Songs** match `s.licence`; **Albums/Compilations** match the stored aggregate `library_albums.licence` ("the album is *entirely* this licence"); **Artists** match any-track. See [music-licence.md](music-licence.md). | `licence=public-domain,cc-by` |
| Starred | `starred=true` | entity-level, see below |
| Duration range (s) | `durMin`, `durMax` | `durMin=120&durMax=360` |

Perceptual axes: `energy`, `danceability`, `valence`, `acousticness`, `instrumental`.
Buckets use fixed thresholds (`BUCKET_THRESHOLDS`): **low ≤ 0.35 < mid < 0.65 ≤ high**.
Buckets OR within an axis, axes AND with each other. Selecting all three buckets of an
axis collapses to `IS NOT NULL` — i.e. **a bucket filter always excludes un-analyzed
tracks**, deliberately, so results are predictable mid-backfill.

Camelot codes expand to both enharmonic spellings (`3B` → `C# major`, `Db major`) via the
`CAMELOT_WHEEL` table in core. The scanner's own key pipeline writes the sharp form; the
flat form covers tag-sourced spellings. A test in `library-filter-sql.test.ts` asserts the
core wheel and `key-detection.ts`'s `keyToCamelot` can never drift apart.

## Matching semantics

- **Any-track matching** (the user-chosen semantic): on album and artist lists, a
  song-level property matches when **at least one** of the entity's tracks matches. One
  `EXISTS` subquery carries the whole conjunction — a *single* track must satisfy all
  song-level conditions together. Artists also match through the `library_song_artists`
  join table, so featured credits count.
- **Starred is the one entity-level property**: `/albums|/singles|/compilations` filter on
  `library_albums.starred`, `/artists` on `library_artists.starred`, and the songs route on
  `library_songs.starred`. It never participates in the any-track EXISTS.

## Implementation

- **`packages/core/src/types/library-filter.ts`** — model, (de)serialization, bucket
  thresholds, `MOOD_VOCAB` (moved here from `audio-tags.ts`, which re-exports it),
  `CAMELOT_WHEEL`/`camelotToKeys`, `activeLibraryFilterCount` (filter-badge count: one per
  property group, one per active axis).
- **`packages/api/src/services/library-filter-sql.ts`** — pure fragment builders
  (`songFilterWheres`, `albumFilterWheres`, `artistFilterWheres`) returning
  `{ wheres, params }` that routes splice into their existing `wheres[]/params[]` arrays.
  Bucket thresholds are inlined as code-constant literals; every user value travels as a
  `?` param (injection-safe).
- Routes parse with `parseLibraryFilter(c.req.queries())` — `queries()` (plural) so the
  repeated `genre` param arrives as an array.

## Performance

The EXISTS probes ride the existing indexes (`idx_library_songs_album_id`,
`idx_library_songs_artist_id`, `idx_song_artists_artist`, `idx_library_songs_genre`,
`idx_song_genres_genre`/`idx_song_genres_song` for the multi-genre EXISTS). At
library scale nothing more is needed; if filtering ever profiles slow, a composite
`(album_id, hidden)` index on `library_songs` is the first thing to add.

## Web UI

The shared panel (`LibraryFilterPanelComponent`) renders the trigger + `MenuPanelComponent`
popover + active-count badge on the four Library tabs and the artist Songs tab. Filter
state is **one shared signal across the four tabs** ("filter my library, then look at it
as albums/artists") and lives in the URL query string — shareable and refresh-proof.
Legacy `type=starred` URLs map to `{ starred: true }` + newest ordering; starred is now a
real WHERE filter, independent of sort. Page-specific extras (Albums' min-tracks /
show-hidden) stay client-side, projected into the panel through its content slot.
