# Joint-credit rule dry run, 2026-11-04

`joint-credits-dry-run.ts` over a copy of prod's music metadata (v0.8.120), with the real
`buildLibrary`, before the rule in #1526 shipped. Nothing on prod was written. The same run on
unchanged code gives the baseline: changes a full scan would make anyway, mostly Lidarr decisions
newer than the last scan.

| Measure | Unchanged code | With the rule |
| --- | --- | --- |
| Songs whose links change | 9 | 1,890 |
| Songs whose album id moves | 0 | **0** |
| Stored songs absent from the build | 4 | 4 |
| Artist rows | 4,412 → 4,419 | 4,412 → 5,515 |
| New artist rows | 10 | 1,235, of which 917 own no album |
| Removed artist rows | 3 | 132 |
| Removed rows carrying curation | 0 | **0** |
| Fake compound rows newly hidden | 0 | 395 |
| Artists grid | 4,224 today | 3,448 with the album floor |

## Left for a human

113 credits on 114 songs name no known artist, so they stay whole until someone answers, for
example `Ana Belén/Víctor Manuel` and `AJ Tracey/Mabel`. The identity task asks Lidarr about these
first and files a card when it has no answer.

## Clean up after the backfill

Of 1,235 new names, two are not artists, and nothing lexical separates them from a real orchestra:
`Orquesta Tipica` (`Ariel Ardit/Orquesta Tipica`, 3 songs) and `Su Orquesta Tipica`
(`Carlos Di Sarli/Su Orquesta Tipica`, 1 song). Merge each into its bandleader.

## After the deploy

Measured on prod against a baseline taken just before merging, same day. The grid figures both use
the album floor, which is why this "before" is 4,230 rather than today's unfiltered count.

| Measure | Before | After |
| --- | --- | --- |
| Album ids moved | | **0** |
| Songs lost | | **0** |
| Curated artist rows (starred, edited or hidden) | 123 | 123, none lost |
| User identity decisions | 47 | 47 |
| Play events | 8,737 | 8,737 |
| Song artist links | 25,099 | 27,772 |
| Artist rows | 4,419 | 5,626 |
| Artists grid | 4,230 | 3,492 |
| Unresolved joint credits | 1,717 | 35 `human` |
| Gramatik-first songs on a Gramatik radio (count 30) | 23 | 1 |

The detector first read 38. The other 3 were its own false positive, fixed in #1612: a user alias
makes `Osvaldo Pugliese/Orquesta Osvaldo Pugliese` one artist, so its single link is correct.

The artist row count ended about 110 above the dry run, probably because the library took in songs
and Lidarr answered more credits between the two; that difference was not traced. `Orquesta Tipica` and `Su Orquesta Tipica` were fixed
by retagging their 4 songs, not by a merge: `merge_artist` writes a permanent alias, which would
credit a later `Juan D'Arienzo/Su Orquesta Tipica` to Carlos Di Sarli.

## What this run could not check

The full list of 1,626 changed credits was scanned by rule for generic and short names, and read in
part. It was not read line by line.
