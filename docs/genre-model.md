# The genre model

Genre is stored twice on purpose, and the two stores answer different questions. Nearly every genre
bug in this repo has been a reader consulting the wrong one, so this page is the single list of who
reads what. **Adding a genre reader means adding a row to the table below.**

→ [library-scanner.md](library-scanner.md) for how the set is built, [genre-radar.md](genre-radar.md)
for how it is visualised, [radio.md](radio.md) for how it is scored.

## Every door onto the genre store must canonicalize (issues #941, #942)

The library has one genre vocabulary and several doors onto it, and a door that
skips canonicalization re-introduces exactly the pollution the vocabulary exists
to keep out.

**The sidecar door (#941).** `mapDiscogsGenres` (#194) keeps Discogs' separator-bearing
top-level names out of the library, and `discogs-genre-vocab.test.ts` pins "never emits a
hard-separator character for ANY top-level genre". It had exactly **one** non-test caller: the
Discogs plugin. But the `genre-audio` enrichment task consumes the *same closed vocabulary* from
the analysis sidecar — `genre_discogs400_labels.json`, 400 classes over 15 distinct genre halves,
byte-identical to `DISCOGS_TOP_LEVEL_GENRES` — and wrote the raw label straight into
`library_genre_overrides` with no `mode`, so it became the song's **primary** genre.

Four of the 15 labels are wrong without the mapping:

| label | what happened | canonical |
| --- | --- | --- |
| `Folk, World, & Country` | stored whole, then shattered by the file-tag mirror on the next scan into `Folk` / `World` / `& Country` | `Folk` / `World` / `Country` |
| `Funk / Soul` | stored whole, and silently excluded from the `known` vocabulary for containing a `/` | `Funk` / `Soul` |
| `Hip Hop` | coexisted with the library's `Hip-Hop` | `Hip-Hop` |
| `Non-Music` | stored as a genre | dropped |

The task now maps the label and skips the write when it maps to nothing — writing an empty set
would *clear* the song's genre rather than leave it alone.

**The artist-scope door (#942).** `POST /api/library/artists/:id/genre` parsed **caller input**
with `splitStored`, whose own docstring says it is the *storage* decoder ("stored form is a
';'-joined ordered list"). It splits on `;` alone, while the song scope and MCP `set_song_genre`
use `parseGenreList` — the scanner's own `SEPARATORS` — so that a curated genre is always a value a
rescan can reproduce. The artist scope therefore accepted a genre the song scope refuses, and
`applyGenreOverride` emitted it verbatim. `splitStored` remains for reading rows back out.

## An artist-wide bad string is one row, not N overrides (issue #949)

`library_genre_aliases` is the only genre store whose granularity matches a catalogue-wide mistag:
one row fixes every song carrying the value, expands one alias into many genres, and survives
rescans without rewriting files. It was reachable only from `reclassify-genres.ts`, so a curation
session could reach `set_song_genre` alone — a *song*-scoped override that cannot express "this raw
string is always wrong". A 44-song artist-wide mistag cost 44 calls and still left future arrivals
broken, because a newly-downloaded track arrives carrying the same string with no override covering
it.

`set_genre_alias` (MCP, `curate`) upserts the row and immediately re-splits the songs that carry
that value — the same mechanism as `backfillGenresFromAliases`, narrowed from the whole library to
the rows the alias can possibly change. Two details that are easy to get wrong:

- **The canonical side goes through `parseGenreList`**, so an alias can never mint a value a rescan
  would re-split differently. That is #942's rule applied to the alias door.
- **The no-op check compares exact strings, not `genreKey`.** The key folds case *and* accents, and
  the largest real instance of this class is precisely a casing repair inside an accented name —
  `Nueva CancióN` → `Nueva Canción`, 44 rows, all at position 3. A key comparison calls that a
  no-op and refuses the fix.
- **An alias canonical's spelling outranks the vocabulary's display casing** (#1074). `splitGenres`
  emits each name in the casing `library_genres` settled on, and `genreKey` folds case, so on prod
  the canonical `Nueva Canción` resolved straight back to the existing `Nueva CancióN` row: the
  alias was written and `songsUpdated` was 0. Consolidations kept the broken form too (three
  `Chanson …` variants merged into `Chanson FrançAise`). `splitGenres` now prefers a canonical's own
  spelling for its key, at curation time and at scan time alike.

Worth knowing when working the rare-genre worklist: **`get_rare_genres` counts the primary genre
only**, so that 44-row value was invisible to it and surfaced only from a direct
`library_song_genres` probe.

## Genre bloat defeats genre selection (issue #960)

Nothing caps how many genres a song accumulates — the enrichment chain (`genre` → `genre-discogs`
→ `genre-audio`) appends, and `set_song_genre` defaults to appending — so against a library mean of
**2.65**, 1,036 songs carry more than 8, 148 more than 16, and the worst carries 33.

`expandGenreWhere` rewrites any `s.genre` predicate to match the whole set, which is correct at the
mean and inverts the intent in the tail: *Rumble* is a dubstep track tagged `Screamo`, `Rock` and
`Country`, so it satisfies nearly every genre filter and surfaces in a Country station, a House
station and a Rock station alike. **Neither change is a defect on its own** — making genre matching
see secondary genres was right, and so is storing everything a source asserts — which is why this
never showed up as one. The effect lands where it is least wanted, too: heavily-tagged songs are
usually popular songs, so the tail is over-represented in selection rather than randomly
distributed.

`GENRE_SET_EXPR` now reads only the first `GENRE_MATCH_POSITIONS` (5) genres by `position`, which
already encodes primary-first ordering, so the cut is meaningful rather than arbitrary and covers
94.6% of songs entirely. This bounds what **matching** sees; every genre stays stored and displayed,
because truncating the stored sets would discard real information and could not be reviewed
meaningfully.

## Two stores

| Store                       | Shape                              | What it answers                       |
| --------------------------- | ---------------------------------- | ------------------------------------- |
| **`library_song_genres`**   | `(song_id, genre, position)`       | *Every* genre a song carries, ordered |
| **`library_songs.genre`**   | one string, mirrors `position = 0` | The song's **primary** genre only     |

The join table is authoritative. The column is a denormalised mirror kept so single-value reads
(sorting, a listing's `genre` field, album/artist aggregates) stay cheap and so rows written before
the multi-genre migration remain readable. **A mirror is only safe while every reader knows which
question it answers** — see the failure modes at the bottom.

## The write path

```
file tags → splitGenres → library_genre_aliases → applyGenreOverride → set + mirror
```

- **`splitGenres`** (`genre-split.ts`) turns multi-valued tag frames into an ordered set. `;` `,` `|`
  split, `&` never does (R&B, Drum & Bass). Deterministic and unit-tested.
- **`library_genre_aliases`** folds spelling/punctuation variants onto a canonical name; human-gated,
  proposed by `reclassify-genres.ts`. `segmentConcatenatedGenre` splits separator-less mashes.
- **`applyGenreOverride`** (`genre-overrides.ts`) applies `library_genre_overrides` at scan time,
  most specific scope first — **song → album → artist**. It is the only genre write that can
  *replace* a primary rather than append. Scopes are `GenreOverrideScope`, the append-vs-replace
  choice is `GenreOverrideMode`, and `GenreOverrideStatus` is the review queue.
- The result is written to `library_song_genres` (position order preserved) and its `[0]` mirrored
  into `library_songs.genre`.

Overrides live in a side table rather than a column because `persist` **deletes and rebuilds every
rescanned song's join rows from the file tags** — a column would be destroyed on the next scan.

### A genre name cannot contain `;`, `,` or `|`

`parseGenreList` (`song-genre-mutate.ts`) — behind `POST /api/library/songs/:id/genre` and the MCP
`set_song_genre` tool — splits caller input on the same hard separators `splitGenres` does. That is
deliberate, not drift: `append` mirrors the merged set back into the file tag, so a name the scanner
would shatter must not be writable through the API either. Issue #913 read the split as a bug and
proposed narrowing it to `;`; that would only move the shatter to the next rescan and leave an
`& Country` fragment in the known-genre vocabulary. The way a separator-bearing external name enters
is by being **canonicalized before ingest**: `mapDiscogsGenres` (`discogs-genre-vocab.ts`, #194)
turns Discogs' `Folk, World, & Country` into `Folk` / `World` / `Country`.

Two write paths do not yet hold the invariant: the `genre-audio` task writes the sidecar's Discogs
labels without `mapDiscogsGenres` (#941), and `POST /api/library/artists/:id/genre` parses caller
input with `splitStored`, the `;`-only *storage* decoder (#942).

### Both stores preserve what a rescan cannot resolve

A file tag that is missing, junk, or dropped by the alias table states **no genre**. It is not an
instruction to forget one. Enrichment and curation write the DB immediately while the file-tag write
lags or fails, so a rescan that treated "resolved to nothing" as "clear it" would revert them.

Both stores therefore preserve:

- `library_songs.genre` via `genre = COALESCE(excluded.genre, library_songs.genre)` in the upsert —
  the same durability contract as `bpm`/`key`/the perceptual axes.
- `library_song_genres` by deleting a song's rows **only when this build resolved at least one
  genre** for it.

The cost is deliberate and shared by both: clearing a genre tag on disk does not clear the stored
one. The way to apply a newly-reviewed alias to stored rows is `backfillGenresFromAliases`, not a
scan.

## Who reads what

| Reader                                            | Matches                        | Why                                                            |
| ------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `library_genres` facet count (scanner)            | **full set**                   | A song counts under every genre it has                          |
| `GET /api/library/genres/songs` (genre page)      | **full set**, primary-ordered  | Must agree with the facet, or a counted genre opens empty       |
| `songFilterWheres` (Library filter, artist Songs) | **full set** *                 | "Electronic; House" should match a House filter                 |
| Radio candidate pooling (`radio.ts`)              | **full set**                   | A shared secondary genre is a real signal                       |
| `genreSetCloseness` (radio scoring)               | **full set**                   | Scores set-against-set, junk vocab filtered first               |
| `artistGenreDistribution` / `albumGenreDistribution` | **full set**                | The radar is about spread, which only the set can show          |
| `listeningStats` genre ranking                    | **join table only**            | Ranks what you actually played, across all its genres           |
| `loadGenreSets`                                   | **full set**                   | The batch accessor; prefer it over ad-hoc queries               |
| Album / artist aggregate `genre` column           | **primary only**               | `mostCommonGenre` over member primaries — one stable label      |
| `libraryHealth` "missing genre" metric            | **mirror column**              | `unresolvedGenreSql` tests the primary against `JUNK_GENRES`    |

\* unless `primaryGenreOnly` is set.

**`primaryGenreOnly` is the one sanctioned way to ask the narrow question.** It is a first-class
field on `LibraryFilter` (`packages/core/src/types/library-filter.ts`), URL-serialised as
`?primaryOnly=true`, and the Library filter exposes it so an extra genre *must not* match (issue
#222). The genre detail page deliberately does **not** take it: ordering primary matches first
serves the same need without adding a mode. Any new reader wanting primary-only semantics should
use this flag rather than reaching for `s.genre` directly.

## The facet count is a snapshot, not a live count

`library_genres.song_count` is materialised at scan time (stamped `synced_at`) and refreshed by the
mutation paths — it is **not** computed on read (`GET /api/library/genres` selects the stored columns
straight).

**The refresh paths are now complete (#771).** The audit found every *mutation* path already correct
— they all route through `setSongGenres`, which recomputes each touched genre — and the gap was
entirely in **deletion**. The album delete pruned only genres that went *empty*, so a genre that
merely shrank kept its old count (removing a 12-track album from a 300-song genre left it reading
300), and the per-song delete did not even do that. Measured on prod 2026-08-27, before the fix:
Synth-Pop 305 → 283, Avant-Garde Jazz 37 → 35.

Both delete paths now call the shared `refreshGenreCounts` (`genre-split.ts`), lifted out of
`setSongGenres` so the two cannot drift. It **joins `library_songs`** in both counts: per-song side
tables deliberately have no FK cascade ([cache-invalidation.md](cache-invalidation.md)), so a deleted
song's `library_song_genres` rows outlive it until the orphan sweep — counting them unjoined would
report the pre-delete number and defeat the point of calling it from a delete at all.

It also counts *every* scanned song, including `hidden` ones, which the listings exclude. Prod
currently has zero, so this is latent rather than active.

## Failure modes this model has actually produced

- **A reader matched the mirror when it meant the set** (#769). `/genres/songs` filtered
  `WHERE s.genre = ?`, so any genre never appearing at position 0 was counted and unreachable:
  **397 of 764 prod genres opened to an empty page**, 631 of 764 showed an inflated count. Fixed by
  matching the full set. The tell was asymmetric documentation — the scanner wrote its semantic
  down, the route documented no predicate at all.
- **The two stores carried opposite durability contracts** (#770). The mirror was
  COALESCE-preserved on a rescan that resolved no genre; the set was deleted unconditionally. Each
  rule is right for one case and wrong for the other, and neither knew which case it was in, so
  **580 prod songs** ended up with a primary and *zero* join rows — invisible to every set reader
  above. It drifted in both directions: 380 were real genres whose file tag had not caught up (the
  set was the stale side), 200 were junk the curator had dropped and `COALESCE` kept alive (the
  mirror was the stale side). Fixed by giving the set the mirror's preserve contract, plus a
  marker-gated one-time `repairGenreMirrorDrift`. The drift was self-perpetuating because
  `backfillGenresFromAliases` walks `SELECT DISTINCT song_id FROM library_song_genres` — a song with
  zero join rows is invisible to the very thing that would have repaired it. This is also why
  `/genres/songs` keeps `s.genre = ?` as one half of its predicate.
- **A curator write that only the scanner could undo** (#762). `set_song_genre` in `mode: 'append'`
  — the **default** — wrote `library_song_genres` and the file tag but **no
  `library_genre_overrides` row**. The override is the only store the scanner re-applies
  (`applyGenreOverride` in `buildLibrary`), so on a song whose tag held a real-but-wrong value the
  rebuild simply won: a genre curated to `Cumbia Pop` came back as `Music`, the generic string
  embedded in the file. It looked like a mid-session regression — `get_library_health` genres-missing
  jumped 734 → 988 with no curator action — because the reverting scan was triggered by unrelated
  downloads landing. #770's fix did not cover it: that protects a rescan resolving *zero* genres, and
  a real-but-wrong tag resolves fine.

  Both modes now write the override, so both are durable. `append` stores only the **curated**
  additions, accumulated across calls, rather than a snapshot of whatever the tags read that day; a
  song already under an explicit `replace` stays there, since appending must not hand authority back
  to the tag. One consequence is deliberate: because `applyGenreOverride` resolves override genres
  ahead of tag genres, an appended curator genre now becomes the **primary**. Mirroring anything else
  at write time would simply disagree with the next scan — which is the drift above.

  The second half was the same defect class as #776: the tag write's boolean was discarded and its
  rejection swallowed, so `{ok: true}` came back either way. It now returns `tagWritten:
  true | false | null` (`null` = not attempted). The curation is durable regardless — the override,
  not the tag, is the mechanism. `tagWritten` reached both API callers (`POST /songs/:id/genre` and
  the `set_song_genre` MCP tool) from day one, but the web UI dropped it on the floor until issues
  #885/#856 wired a curator-facing warning — see
  [web-ui.md](web-ui.md#a-failed-tag-mirror-is-surfaced-to-the-curator-issues-885-856).
- **Junk vocab scored as identity** (#583). `Other` = `Other` matched at 1.0 in radio. `JUNK_GENRES`
  + `isRealGenre` now strip it before any comparison; an all-junk side reads as *absent*.
- **An ASCII-only normaliser folded unrelated names together** (#720 cluster). Genre and artist
  matching must fold Unicode, not strip to ASCII; `COLLATE NOCASE` is ASCII-only.
