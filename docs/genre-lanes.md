# Deterministic genre lanes

Genres a genre-less song can be given with **no model**, from evidence already in the library
(#1516 P3). Code: `packages/api/src/services/genre-lanes.ts`.

**Status: a measurement.** The lanes find candidates and the health report counts them. Nothing
writes a genre from them yet. The predicates have to be tabulated on the real library and a sample
checked by hand first: "the siblings agree" has been wrong before (see below).

## The lanes

| Lane | A genre-less song gets a genre when | Writes |
| --- | --- | --- |
| `title` | its title lists at least two genres in **square** brackets, all in the vocabulary: `Doorways [Downtempo / Folktronica]` | every listed genre, in order |
| `siblings` | at least two **other albums** by the same artist each have a dominant genre, and all of them agree | that one genre |

Rules, in `GENRE_LANE_RULES`:

- **Vocabulary.** Only a genre `autoGenreVocabulary` allows: carried by at least 3 songs, not junk
  vocab, not a catch-all (Electronic, Dance). The same list a `refiner:auto` token may write.
- **A candidate is a song with no usable genre** (`unresolvedGenreSql`): empty, or junk vocab.
  A song with a catch-all as its only genre is not a candidate here.
- **`title`: one bracketed word is not a list.** `[Live]` and `[Acoustic]` are versions. Round
  brackets are never read.
- **`siblings`: the unit is the album, not the song.** One rip tags every track alike, so eleven
  tracks from one album are one source. An album counts when one genre holds 80 % of its tagged
  songs; the song's own album never counts; one disagreeing album cancels the answer.
- **`siblings` skips Various Artists and placeholder artists.**
- A song both lanes reach is reported under `title`.

Not built: the third lane the issue names, MusicBrainz artist genres. The library stores no
per-artist MusicBrainz genre list to read.

## Where to read it

`get_library_health({ dimensions: ["genres"] })` → `genres.deterministicLanes`:

- `counts`: songs per lane.
- `siblingArtists`: distinct artists the sibling lane draws on.
- `sample`: candidates with the genres a lane would write and one phrase of evidence each
  (`2 other albums by Artist agree`), half from each lane.

## Before this may write

1. Read the counts on prod.
2. Check a sample by hand, per lane. The sibling lane is the one to distrust: an artist whose
   catalogue spans styles fails the "all agree" test, but an artist with two albums of one style
   and a new single in another passes it.
3. Only then add the enrichment task that applies them, off by default, writing through the same
   durable override `set_song_genre(mode: replace)` uses and logged as an agent run so it can be
   reverted (`agent-runs.ts`).
