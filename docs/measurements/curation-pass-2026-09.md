# Curation pass — 2026-09 (a wrong artist *name* had no detector)

Curator-reported, not health-report-driven: the owner spotted 15 artist tiles in the web UI
sharing the prefix `Sanampay`, plus one named `[99] TE VAS`. Neither was in any worklist,
because **no rule in the system iterated artist names for plausibility**. This pass fixed
the two cases, measured the class, and closed the detector gap.

## Library totals (2026-09-01, prod `kpc`)

3,175 artists · 5,733 albums (5,732 visible) · 17,505 songs.

## Case 1 — `Sanampay` × 15 rows

One real album, **Sanampay — "En Esta Hora..." (1997, 16 tracks)**, arriving as 15 artist
rows. Every suffix is the **composer of that exact track**, corroborated one by one:

| track | suffix | reality |
| --- | --- | --- |
| volver a los 17 | `V. PARRA` | Violeta Parra wrote it |
| minha historia | `CH. BUARQUE` | Chico Buarque wrote it |
| adagio en me país | `A. ZITARROSA` | Zitarrosa wrote it |
| los mareados | `J.C. COBIÁN - E. CADICAMO` | Cobián (music) + Cadícamo (lyrics) |
| alfredianas | `HNOS. HENRÍQUEZ - N. LABRÍN` | Labrín founded Sanampay |
| el colibrí, sau-sau | `D.P.` | *dominio público* |

`D.P.` is the decisive tell: "public domain" only ever appears in a composer field.
Sanampay is a real group — founded in Mexico in 1977 by Naldo Labrín in exile after the
1976 Argentine coup.

**Provenance: the yt-dlp acquire lane.** The files still carry the YouTube auto-generated
description:

```
TAG:synopsis=Provided to YouTube by The Orchard Enterprises
adagio en me país · Sanampay · A. ZITARROSA
En Esta Hora...
℗ 1997 Difusora del Folklore
```

YouTube's format is `TITLE · ARTIST · ARTIST…`; The Orchard put the composer in slot two,
and the lane comma-joined every credit into `ARTIST`. Two further losses in the same file:
`TAG:date=20150502` is the **upload** date and became the album year (the real `℗ 1997` sat
unread in the synopsis), and `album_artist=Various Artists` + `COMPILATION=1` were stamped
on a single-artist album. → issue #866.

## Case 2 — `[99] TE VAS`

Video title `[99] TE VAS - DJ LOCO CABANA-PERU FT. DVJ LUIS BRAVO` (a Peruvian DJ-pool
channel) written as `ARTIST=[99] TE VAS` / `title=DJ LOCO CABANA-PERU FT. DVJ LUIS BRAVO`
— the lane assumed `ARTIST - TITLE`; DJ packs are `[NN] TITLE - DJ`. `sanitizeArtistTag`
**did** run and passed it: `TRACK_NUM_PREFIX` requires a bare leading digit, so `[99]`
never matched. `identify_song` returned `no-match` (genuinely unknown to AcoustID, expected
for a channel-exclusive edit), so the retag used the corroborated channel identity.

## Why neither was ever reported

Four things had to line up; the fourth is the one worth remembering.

1. **No name validation on the scan path.** `resolveTags` takes the tag as-is;
   `sanitizeArtistTag` is organizer-only; `normalizeArtistForGrouping` preserves
   punctuation by design, so `Sanampay, A. BORDA` ≠ `Sanampay` by construction.
2. **`split_compound` inverts visibility.** `splitArtists` is all-or-nothing. An
   *unresolved* compound yields one primary → `split_compound = 0` → the grid renders it;
   a *resolved* one is hidden. Measured: 13 of 15 legitimate `Luciano Pavarotti, <orchestra>`
   rows were correctly hidden, while all 14 junk `Sanampay, <composer>` rows displayed.
   **The rows most likely to be junk are exactly the ones that show.**
3. **Nothing iterated `library_artists` for fragmentation.** `checkFragments` and
   `checkMisSplitAlbums` key on album *title*; `checkPollutedArtists` was a
   keyword/number/DJ-set list with no comma-compound rule. `libraryHealth`'s 11 dimensions
   include none for artist-name plausibility.
4. **The system already knew and had nowhere to say so.** `pendingArtistIdentityRows`
   selects on `name LIKE '%, %'` — it picked these rows up, failed to resolve them against
   Lidarr, recorded `decision: 'unknown'` and muted itself for 7 days. No finding, no flag,
   no metric. *A component that detects something and reports nothing is indistinguishable
   from no detector at all.*

## Scale of the class

3,175 artists: 141 contain `, `; 431 have `album_count = 0`. Prefix-fragmented clusters:

| base | rows | albums | verdict |
| --- | --- | --- | --- |
| Luciano Pavarotti | 15 | 1 (`Luciano Pavarotti - The Best`) | **shredded — same defect, still open** |
| Sanampay | 14 | 1 | shredded — fixed this pass |
| Matias Aguayo | 4 | 1 | real collaborations |
| Charlotte de Witte / Eelke Kleijn / Los Ángeles Azules / Sentimental Animals / Tego Calderón | 2 each | 1–2 | real collaborations |

Pavarotti was the surprise: it looked like the counter-example that would force a
high-precision predicate, and turned out to be **the same defect** — one album, one artist
row per track, the album itself shredded into 16 album rows. The measured gap between
shredded (14–15) and genuine (2–4) is what the detector keys on.

## Actions

| Action | Count | Verified by |
| --- | --- | --- |
| `fix_song_metadata` — artist + albumArtist + title | 16 | direct prod DB read |
| `fix_album_metadata` — artist/year/releaseType | 1 | `library_metadata_overrides` row present |
| `merge_artist` — composer rows collapsed | 14 → 1 | direct prod DB read |
| `[99] TE VAS` retagged + merged | 1 | direct prod DB read |

Artist rows for these two cases: **16 → 2**.

## Detector added

`findArtistFragmentClusters` (`library-quality.ts`) + `fragmented_artist`
(`library-audit.ts`, medium, never deletable). Gate is `minFragments = 2` — maximum recall,
owner's call: a size threshold would sit inside the measured 4→14 gap, and only a human can
tell a composer credit from an orchestra credit, so the finding is advisory and the curator
judges. Replayed over the real 3,157-row population: **6 clusters in 6.1 ms**, matching the
table above.

## Issues filed

- **#864** — a wrong artist NAME has no detector; `split_compound` visibility is inverted.
- **#865** — `fix_song_metadata` returns `verified: true` for an `albumArtist` it silently
  did not write on a `COMPILATION=1` file. Not a silent revert but an **affirmative false
  confirmation** — worse than #760, whose family it belongs to.
- **#866** — the yt-dlp lane comma-joins YouTube's `·` credit list into `ARTIST`, prefers
  the upload date over `℗`, and splits `[NN] TITLE - DJ` backwards.

## Still open

- **Luciano Pavarotti — 15 rows, one shredded album.** Same fix shape as Sanampay, but the
  suffixes are real performing credits (orchestra + conductor), so the merge loses genuine
  information the composer case did not. Needs an owner ruling before touching.
- `fragmented_artist` has not yet run against prod — it ships in this change.
