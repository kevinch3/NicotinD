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
| Genre | `genre` (repeated param — free text may contain commas). Matches the **full multi-genre set**: the predicate is `(s.genre IN (…) OR EXISTS(… library_song_genres …))`, so a track filed under "Electronic; House" matches a House filter; the primary-column IN keeps pre-first-rescan rows filterable. Which readers match the set and which match the primary is tabulated in [genre-model.md](genre-model.md). | `genre=Rock&genre=Hip-Hop` |
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
  subquery carries the whole conjunction — a *single* track must satisfy all song-level
  conditions together. Artists also match through the `library_song_artists` join table,
  so featured credits count: an artist matches `country=CL` when they are credited on a
  song whose credited-artist set includes a CL artist, which deliberately includes a
  foreign artist featured on a Chilean track. See [Performance](#performance) for why this
  is a membership test rather than a correlated `EXISTS`.
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
  The two entity builders share `entityFilterWheres`, which takes the `SELECT <entity id>
  FROM …` prefixes to UNION rather than an entity correlation predicate.
  Bucket thresholds are inlined as code-constant literals; every user value travels as a
  `?` param (injection-safe).
- Routes parse with `parseLibraryFilter(c.req.queries())` — `queries()` (plural) so the
  repeated `genre` param arrives as an array.

## Performance

**The song predicate must be evaluated once, as a membership test — never as a correlated
`EXISTS` per entity row.** `entityFilterWheres` emits

```sql
library_artists.id IN (SELECT ls.artist_id FROM library_songs ls WHERE <song wheres>
                       UNION
                       SELECT sa.artist_id FROM library_song_artists sa
                         JOIN library_songs ls ON ls.id = sa.song_id WHERE <song wheres>)
```

because the song wheres read only `ls`, never the entity. Written as
`EXISTS (… WHERE <entity correlation> AND <song wheres>)` — the shape this file described
until #1055 — SQLite cannot hoist it, so it re-derives the entire matching-song set for
*every* entity row, and a non-matching entity scans every song before it can say no.

Measured on prod (20,906 visible songs / 3,560 visible artists), old vs. new, **identical
id sets** in both cases:

| query | correlated `EXISTS` | membership | speedup |
| --- | --- | --- | --- |
| `/artists?country=CL,AR` (393 rows) | 204,859 ms | 118 ms | 1,737× |
| `/artists?genre=Rock` (432 rows) | 184,616 ms | 91 ms | 2,021× |
| `/albums?country=CL,AR` (1,439 rows) | 58,450 ms | 64 ms | 907× |

**No index fixes the correlated form** — the shape is the cost, which is why the old advice
here ("if filtering ever profiles slow, add a composite index") pointed at the wrong lever.
The membership probes ride the existing indexes (`idx_library_songs_album_id`,
`idx_library_songs_artist_id`, `idx_song_artists_artist`, `idx_library_songs_genre`,
`idx_song_genres_genre`/`idx_song_genres_song`).

Two consequences worth holding onto:

- **The artists form inlines the song wheres twice** (one per UNION branch), so
  `entityFilterWheres` pushes `song.params` once per selector. A placeholder/param mismatch
  throws at query time, not at build time; `library-filter-sql.test.ts` pins the binding.
- **A slow query here stalls everything.** `bun:sqlite`'s `.all()` is synchronous inside a
  synchronous Hono handler, so one filtered request occupied the single Bun event loop for
  ~3 minutes — songs, cover art and the container health check all queued behind it. That
  is why the reported symptom was "the country filter returns unfiltered results" (the
  request never completed; the web layer's 30 s `artistsCache` kept the stale list on
  screen) *and* "filtering songs is slow" (songs were fine at 82 ms — they were queued).
  See [Detecting the next one](#detecting-the-next-one).

`db.perf.test.ts` guards the shape via `EXPLAIN QUERY PLAN`, not wall-clock, so it cannot
flake on a loaded box.

### Detecting the next one

#1055 removed *a* quadratic query; it could not remove the property that makes one an
outage rather than a slow page. `startLoopBlockMonitor`
(`packages/api/src/services/loop-block-monitor.ts`) reports when the process stopped, and
`trackInFlight` (`packages/api/src/middleware/in-flight.ts`) says which request was holding
it — during #1055 the only visible symptom was a container flapping `Health check exceeded
timeout (5s)`, and nothing named the query.

It measures **timer lateness, not request duration**, which is what makes it quiet: a
legitimately long *async* response (a stream) never stops timers from running and is never
reported, while a synchronous `.all()` is reported by definition. The in-flight label
carries query param *names* only — a filter value is library content, not a log line.

**This detects; it does not pre-empt, because in this process nothing can.** `bun:sqlite`
exposes neither `sqlite3_interrupt` nor a progress handler. The obvious workaround — stream
with `.iterate()` and abandon the query past a deadline — was measured and does not work
here: the list queries end in `USE TEMP B-TREE FOR ORDER BY`, so on a 3,000-artist fixture
the first row arrives at 2,935 ms against 2,928 ms for the whole `.all()`. There is no
"between rows" to check a deadline in. Real pre-emption needs the query off this loop
entirely (a worker connection), which is still open on #1058.

## Web UI

The shared panel (`LibraryFilterPanelComponent`) renders the trigger + `MenuPanelComponent`
popover + active-count badge on the four Library tabs and the artist Songs tab. Filter
state is **one shared signal across the four tabs** ("filter my library, then look at it
as albums/artists") and lives in the URL query string — shareable and refresh-proof.
Legacy `type=starred` URLs map to `{ starred: true }` + newest ordering; starred is now a
real WHERE filter, independent of sort.

**A list that could not be loaded says so** (`LibraryListErrorComponent`, #1059). The four
whole-library tabs share one fetch lane (`LibraryComponent.loadList`) which, on failure,
clears the list and renders the error with a retry — it does not keep the previous rows.
With a filter active, stale rows are not merely unhelpful, they contradict the filter chips
above them: that is precisely how #1055's timeout was reported as "the filter returns the
same results". For the same reason a failed fetch does not render "No artists found" —
that is a claim about the library, and all we know is that the request failed.

The Songs tab is the one tab whose filter panel belongs to the child
(`LibrarySongsComponent`), so `LibraryComponent.onFilterChange` deliberately has **no
`songs` branch** — the child has already reloaded by the time the change bubbles up, and a
branch here would double every request (#1060). The child mirrors the `filter` input rather
than seeding it once, so a filter arriving from anywhere other than its own panel still
lands. Page-specific extras (Albums' min-tracks /
show-hidden) stay client-side, projected into the panel through its content slot.

Every library surface (Albums, Compilations, Singles & EPs, Artists, Library Songs,
Artist-page Songs, Album detail, offline Songs) shares **one inline toolbar pattern**:
`search · sort · direction · filters`, all rendered as bare
`py-1.5 text-sm rounded-lg bg-theme-surface-2` controls with `focus:ring-1
focus:ring-[var(--theme-accent)]`. The previous `app-list-toolbar` component (a bordered
bar with internal layout) was retired because it sat at a different height than the
inline controls, breaking the unified toolbar row. Inside the popover the same idiom is
applied uniformly — number inputs, the min-tracks select, all checkboxes
(`accent-theme rounded`), and the chip rows (mood / perceptual axes / Camelot
key) share one shape (`px-2 py-0.5 text-xs rounded-full`).
