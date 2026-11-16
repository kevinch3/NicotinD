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
- **A candidate is a song a `refiner:auto` token could replace:** one with no usable genre
  (`unresolvedGenreSql`: empty, or junk vocab), or one whose only genre is a catch-all
  (`lowInformationOnlyGenreSql`). The report splits the two as `byNeed`. A catch-all beside a real
  genre is never a candidate.
- **A catch-all is not evidence.** An album dominated by Electronic or Dance is skipped by the
  sibling lane: it neither names a style nor contradicts one.
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
- `byNeed`: the same songs split into `missing` and `catch-all`.
- `siblingArtists`: distinct artists the sibling lane draws on.
- `sample`: candidates with the genres a lane would write and one phrase of evidence each
  (`2 other albums by Artist agree`), half from each lane.

## Measured on prod, 2026-11-16

First version (genre-less candidates only), 33,757 songs, 196 with no usable genre:

| Lane | Songs it would tag |
| --- | --- |
| `title` | 0 |
| `siblings` | 0 |

Checked one case by hand: Adam Port has a genre-less song and four other albums, tagged Deep House,
Melodic House, Melodic House and House. They disagree, so the lane rightly has no answer. The
genre-less residue is what every automated lane already failed on, so "all the artist's albums
agree" has nothing to add there. That is why the candidates were widened to catch-all-only songs
(237 on that date), which is the population #1123 is about.

Second version (also catch-all-only songs), read the same day after the deploy:

| | Songs |
| --- | --- |
| `title` | 0 |
| `siblings` | 24, across 8 artists, every one a catch-all-only song |

All 24 were checked by hand:

| Verdict | Songs | Which |
| --- | --- | --- |
| Right | 4 | Daft Punk *WDPK 83.7 FM* → House; Marian (BR) → Tech House; Ramon Bedoya → Tech House; Moderat → Idm |
| Right answer, wrong reason | 1 | *Sweet Love* by Luca M/JUST2, tagged from the albums of the DJ whose mix it sits on |
| Doubtful | 16 | Chet Faker's 2012 and 2014 records → Soul, because his two later albums are tagged Soul |
| Wrong | 3 | Tiësto's 2020s pop-dance singles → Trance (seven older albums agree); a David Guetta remix of a RAYE song → Pop |

Four to five clearly right out of 24. The three wrong ones are the same failure: an artist's older
albums agree on a style the newer song does not have, and "all the albums agree" cannot see a
change of direction. The mix case shows a second gap: the lane reads the artist the *row* is filed
under, which on a DJ mix is not the artist who made the track.

**Decision: the task that applies the lanes is not built.** The title lane finds nothing in this
library and the sibling lane is wrong too often to write without a person. The four right answers
were written by hand through `set_song_genre(mode: replace)` and read back (the lane's count went
from 24 to 20). The measurement stays in the health report as a worklist of suggestions a curator
can accept or reject one by one.

## If this is ever reconsidered


1. Read the counts on prod.
2. Check a sample by hand, per lane. The sibling lane is the one to distrust: an artist whose
   catalogue spans styles fails the "all agree" test, but an artist with two albums of one style
   and a new single in another passes it.
3. Only then add the enrichment task that applies them, off by default, writing through the same
   durable override `set_song_genre(mode: replace)` uses and logged as an agent run so it can be
   reverted (`agent-runs.ts`).

## Umbrella-only songs, and what an artist's own catalogue could resolve (#1123)

`umbrellaReach` answers the second step of #1123 with the wider umbrella list that issue measured
(`UMBRELLA_GENRES`: Pop, Rock, Latin, Electronic, Dance, Singer-Songwriter, Pop Rock, World, Funk,
R&B, Soul), not only the two catch-alls an unattended token may replace.

- `umbrellaOnly`: songs whose whole genre list is one of those.
- `reachable`: of them, songs whose artist has two or more **other** albums agreeing on a specific
  genre, with every umbrella-dominated album ignored as evidence.
- `byUmbrella`: both numbers per umbrella.

Read it at `get_library_health({ dimensions: ["genres"] })` → `genres.umbrellaReach`. "Reachable"
means a suggestion exists. The hand-check above is how often such a suggestion was right.

