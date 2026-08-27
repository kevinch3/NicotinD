# The genre model

Genre is stored twice on purpose, and the two stores answer different questions. Nearly every genre
bug in this repo has been a reader consulting the wrong one, so this page is the single list of who
reads what. **Adding a genre reader means adding a row to the table below.**

→ [library-scanner.md](library-scanner.md) for how the set is built, [genre-radar.md](genre-radar.md)
for how it is visualised, [radio.md](radio.md) for how it is scored.

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

`library_genres.song_count` is materialised at scan time (stamped `synced_at`) and refreshed by a
few mutation paths — it is **not** computed on read. It can therefore lag a delete. Measured on prod
2026-08-27: 2 of 764 genres (Synth-Pop 305 → 283, Avant-Garde Jazz 37 → 35). Whether the refresh
paths are complete is #771.

It also counts *every* scanned song, including `hidden` and quarantined (`landed_at IS NULL`) ones,
which the listings exclude. Prod currently has zero of both, so this is latent rather than active —
but a large in-flight download batch would make the counts read high until the songs land.

## Failure modes this model has actually produced

- **A reader matched the mirror when it meant the set** (#769). `/genres/songs` filtered
  `WHERE s.genre = ?`, so any genre never appearing at position 0 was counted and unreachable:
  **397 of 764 prod genres opened to an empty page**, 631 of 764 showed an inflated count. Fixed by
  matching the full set. The tell was asymmetric documentation — the scanner wrote its semantic
  down, the route documented no predicate at all.
- **The mirror and the set drifted apart** (#770). 580 songs carry a primary in `library_songs.genre`
  with *zero* join rows, making them invisible to every set reader above. This is why `/genres/songs`
  keeps `s.genre = ?` as one half of its predicate — there it stands in as position 0.
- **Junk vocab scored as identity** (#583). `Other` = `Other` matched at 1.0 in radio. `JUNK_GENRES`
  + `isRealGenre` now strip it before any comparison; an all-junk side reads as *absent*.
- **An ASCII-only normaliser folded unrelated names together** (#720 cluster). Genre and artist
  matching must fold Unicode, not strip to ASCII; `COLLATE NOCASE` is ASCII-only.
