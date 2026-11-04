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

## What this run could not check

The full list of 1,626 changed credits was scanned by rule for generic and short names, and read in
part. It was not read line by line.
