# Artist mash segmentation: false-cover rate on prod (#860)

Companion to [../library-scanner.md](../library-scanner.md) ("Per-candidate segmentation").
#948 shipped `segmentEachCandidate`, which runs `segmentConcatenatedArtist` on **every delimiter
candidate of every compound credit**. #212's null result (2,471 artists, zero full confirmed covers)
covered whole artist names only, so the new population had never been measured. The owner's
2026-09-27 ruling on #860 (the re-mint owner is the segment that already owns a same-title album,
and nothing is re-minted when no segment does) required this measurement before any re-mint ships.

## Status

Run on **2026-09-27** against prod (`kpc`, v0.8.91). `artist-split.ts`, `album-grouping.ts`,
`artist-identity-store.ts` and `library-quality.ts` on prod are byte-identical to master (md5
compared). **Nothing was written.** One `bun:sqlite` `{readonly:true}` dump of `library_songs`,
`library_albums`, `library_artists`, `library_song_artists`, `library_artist_identity` and
`library_artist_aliases` was taken, and then the real functions were replayed locally
(`docs/prod-inspection.md` "The rule"):

- **Authority**: the real `loadSplitAuthority`, run on an in-memory DB rebuilt from the dumped
  rows. On top of that, `buildLibrary`'s pass 1 (alias pairs plus atomic owners). That gives
  **5,140** confirmed names and **233** `canonicalWhole`.
- **Split**: the real `splitArtists` over every distinct stored `artist` and `album_artist` string.
  These are the exact inputs the scanner splits, because `library_songs.artist` stores the
  alias-fixed credit verbatim. Which path fired (delimiter gate, per-candidate, or whole-primary)
  was reconstructed from the exported `splitOnDelimiters` and `segmentConcatenatedArtist`, then
  **asserted equal to `splitArtists`' output for every credit: 0 mismatches**.
- **Owner signal**: the real `findRepresentedFragments`, fed one synthetic `"<segment>, <rest>"`
  row per segment. The rotation is needed because the function only tests a *prefix* base, and an
  owner can be any segment (Dua Lipa is the second segment of her own credit).

## Population

| population | n | with a legal cut (`\p{Lu}` after a letter/digit) |
| --- | ---: | ---: |
| distinct credits | 5,389 | |
| compound credits (>1 delimiter candidate) | 916 | |
| of those, split by the delimiter gate (segmenter never runs) | 578 | |
| **delimiter candidates of compound credits (#860's population)** | **1,385** distinct | **107** |
| atomic credits (#212's whole-name population) | 4,460 | 605 |

## Results

### Segmentations that fired on prod today: 1, and it is false

| credit | path | segments | corroboration against the track | verdict |
| --- | --- | --- | --- | --- |
| `IDEMI` | per-candidate (single candidate) | `ID` + `EMI` | *Dum Dum*, *Outta The Box* (Hottrax 2024). IDEMI is one act, the house duo of twins Rhett and Conran Lee | **false cover, LIVE** (#1427) |

This is live in the shipped code. `library_song_artists` links *Dum Dum* to `ID` and `EMI`, and the
`IDEMI` row carries `split_compound = 1`, so the real artist is **hidden from the grid**. `ID` is
confirmed only by two Green Velvet DJ-mix tracks tagged `ID` (the "unidentified track" convention),
which makes it a placeholder that reached `confirmedArtists`. The case sits in the atomic
population, which means **#212's null result no longer holds either**: the confirmed vocabulary
grew a 2-character placeholder after it was measured.

### Every cover the segmenter would produce, landed or not

`segmentConcatenatedArtist` was run against every name in both populations, whether or not the
all-or-nothing gate lets it land today:

| population | covers | false | correct |
| --- | ---: | ---: | ---: |
| 1,385 compound candidates | 1: `AMEME` → `AME` + `ME` | 1 | 0 |
| 4,460 atomic credits | 1: `IDEMI` → `ID` + `EMI` | 1 | 0 |

`AMEME` is AMÉMÉ, credited in `Michel Cleis, Toto La Momposina, AMEME` (*La Mezcla*, AMÉMÉ
Extended Remix). `ME` is confirmed through `library_artist_identity` splits of
`ME, Rampa, Adam Port` (&ME), and `AME` through `Rhye, Âme`. The only thing blocking it today is
another candidate that is not confirmed. Once `Michel Cleis` or `Toto La Momposina` is, the cover
lands. **This is the exact shape #860 warned about: a short confirmed name inside a delimiter
candidate.**

### Bucketed by the defect axis (shortest segment)

The confirmed vocabulary holds 5 names of 1–2 characters (`bm`, `id`, `me`, `nf`, `齊豫`), 161 of
3–4 characters, and 4,974 of 5 or more.

| shortest segment | covers | false | false-cover rate |
| --- | ---: | ---: | --- |
| 1–2 chars | 2 | 2 | **2 / 2** |
| 3–4 chars | 0 | 0 | n = 0, not tested by prod data |
| 5+ chars | 0 | 0 | n = 0, not tested by prod data |

The population is small enough that nothing was sampled: every cover is listed above. The 3–4 and
5+ buckets are **empty**, not passed. Prod currently holds no genuine mash in either bucket,
because the known ones were fixed by hand during the #860 triage.

### Counterfactual: the known genuine mashes against today's authority

| mash | `splitArtists` today | shortest segment | owner via `findRepresentedFragments` |
| --- | --- | ---: | --- |
| `Los NocherosLos Tekis` | `Los Nocheros` / `Los Tekis` | 9 | Los Nocheros (owns *Chamame*) |
| `2 MinutosTruenoDie Toten Hosen` | `2 Minutos` / `Trueno` / `Die Toten Hosen` | 6 | none: left alone |
| `MalumaCosculluela` | `Maluma` / `Cosculluela` | 6 | Maluma (*Pretty Boy, Dirty Boy*) |
| `J. BalvinDua LipaBad Bunny & Tainy` | whole (prod spells it `J Balvin`) | n/a | Dua Lipa (*Future Nostalgia*), the 2nd segment |

With a segment floor of **3, 4 or 5**, both false covers disappear and all three segmentable
genuine mashes still split identically.

### Sizing the re-mint

- **Correct segmentations live on prod today: 0.** A re-mint shipped now would re-mint no album.
  Every correct mash on prod was already fixed by hand.
- Counterfactually, 3 of the 4 known genuine mashes have an owner segment (they would re-mint) and 1
  has none (it would be left alone, per the ruling). The owner is **not** always the first segment,
  so the picker must test every segment, not only `findRepresentedFragments`' prefix base.

## Verdict

**Needs a guard.** The re-mint as ruled is not safe on the current segmenter. Every segmentation
prod has produced is false (1 live, plus 1 latent in the #860 population). A re-mint on top would
turn a wrong join row into a wrong album id. The smallest guard the data supports is a **segment
floor of 3 characters** (`MIN_ARTIST_SEGMENT` 2 → 3, which applies to pieces of a mash only; `U2`
as a whole artist is unaffected). It removes 2 of 2 false covers and keeps all 3 correct splits. It
fixes a bug that is live today whether or not the re-mint ships (#1427). The 3–4 and 5+ buckets are
untested (n = 0), so re-run this replay after the guard lands and before the re-mint ships.

Reproduce: dump the tables above read-only, then `bun run` a replay that imports
`splitArtists`, `splitOnDelimiters`, `segmentConcatenatedArtist`, `loadSplitAuthority` and
`findRepresentedFragments` from `packages/api/src/services/`, following the "dump prod, replay the
pure function locally" pattern in [../prod-inspection.md](../prod-inspection.md).
