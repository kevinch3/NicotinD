# Curation pass — 2026-11 (joint credits cleared; a compound album artist still owns its album)

Run against prod over MCP on 2026-11-09, refiner scope. Covered flags, `jointCredits`,
`genres.lowInformation` and `years`.

## Library totals (2026-11-09)

5,750 artists · 7,929 albums (all visible) · 26,048 songs.

## Baseline → final

| Metric | Baseline | Final | Delta |
| --- | --- | --- | --- |
| flags.open | 3 | 1 | −2 |
| jointCredits.credits (all `human`) | 6 | 0 | −6 |
| genres.lowInformation | 249 | 143 | −106 |
| years.missing | 188 | 181 | −7 |
| years.missingMultiTrack | 17 | 10 | −7 |
| genres.missing | 152 | 152 | 0 |
| artists | 5,735 | 5,750 | +15 (new member rows from the splits) |

Every number above was re-read from `get_library_health` after the writes. `lowInformation` was read
after each artist batch: 249 → 202 (−47) → 143 (−59). Each step equals the songs written.

## Flags

| Flag | Report | Outcome |
| --- | --- | --- |
| 75 | listener, `misplaced: joint artist`, Anitta/Maluma *El Que Espera* | Resolved. The song credit was already `auto` and links both artists. What the listener sees is the album-artist bucket, filed as **#1804**. |
| 79 | listener, `missing: artwork`, Los Ladrones Sueltos *No Le Dijo Nada* | Resolved. Cover set from the exact Discogs match (2017, score 100). Read back: `hasCanonicalCover: true`. |
| 28 | listener, `quality`, Natiruts *Glamour Tropical* (Box Natiruts) | Re-filed as a `listen` card (Spanish): **delete this copy** or **keep it**. `identify_song` matched (0.95), so the file decodes. 98 kbps sits inside the box's 83–117 kbps range. The other three copies are live recordings, so deleting this one loses the studio take. |

## Joint credits (all six were `human`)

Each was checked against its own track before the split.

| Credit | Split into | Evidence |
| --- | --- | --- |
| `DJ Rossini ZS/DJ MENOR DA Z.O/MC Zudo Boladão/MC LUIS DO GRAU` | 4 | *Automotivo Blindado*, a Brazilian funk track. Each DJ/MC credit is a separate artist. |
| `Olly Alexander (Years & Years)/Gryffin` | 2 | *Desire - Gryffin Remix*. The first name is an existing artist row, reused verbatim. |
| `vbnd/Katie Tupper/The Soulmate Collective` | 3 | *Breathe Me In (A Little Longer)* |
| `Peter Capusotto y sus Videos/Bombita Rodriguez` | 2 (`Bombita Rodríguez`) | *Blues de Perón*. Bombita is the show's character, credited as an artist. |
| `Rafa y Chinin/El Otro Polo` | 2 | Rafa y Chinin is a Venezuelan duo with its own artist page, so it is one act and one member. |
| `Huinca/Gabriel Ranelli, Cacho Lafalce & Oscar Moro` | 4 (`Huinca`, `Gabriel Ranelli`, `Cacho Lafalce`, `Oscar Moro`) | Huinca is the 1972 Nebbia/Ranelli/Lafalce/Moro band (Progarchives line-up). The comma part lists the band's members, and each played on the track. |

Also recorded `split_artist(Anitta/Maluma)`, for flag 75. It changed nothing visible (see below).

## Umbrella-only genres (`mode: replace`, counts matched against the worklist)

| Artist (worklist row) | Songs | Album(s) | Genre written | Evidence |
| --- | --- | --- | --- | --- |
| Die Antwoord | 28 | *Mount Ninji and da Nice Time Kid* (16), *House of Zef* (12) | `Hip Hop; Electronic` | Over 60 sibling releases from separate singles carry `Hip Hop`. `Electronic` is kept for the rave side. |
| Damian Lazarus | 28 | *Message From the Other Side*, two rips (opus 14 + mp3 320 14), by Damian Lazarus & The Ancient Moons | `Deep House; Downtempo` | Two independent sources by the same act agree: *Heart of Sky* (`Deep House; Downtempo; Electronic`) and *Smoke the Monster Out* (whose compound tag names Downtempo and Deep House). |
| PSY | 19 | *Gangnam Style* | `K-Pop` | Sibling *칠집싸이다* is `K-Pop`, and *싸이파이브* carries K-Pop in its set. The artist is from KR. |
| Stromae | 12 | *Multitude* | `Electropop` | Siblings: *Cheese* `Electro House`, *Racine carrée* `Dance-Pop`. |
| Christian Löffler | 11 | *A Life* | `Ambient House` | A separate rip of *Felt* on the same album is tagged `Ambient House; Ambient Techno; Microhouse; …`, and sibling *Closer* is `Ambient House`. |
| Radiohead | 8 | *The King of Limbs* | `Alternative Rock; Electronic` | Five sibling albums are `Alternative Rock`. *Kid A*'s full set carries both. |

The Damian Lazarus row repeats October's finding: the row's label is not the artist of its songs.
None of his own four albums held an Electronic-only song. The 28 were the Ancient Moons rips.

## Years (`fix_album_metadata`)

Green Day *Warning:* 2000 (49 songs: a 3-disc edition of the album, demos and 2001 Tokyo live; the
year is the release group's) · *¡Uno!* 2012 · *¡Tré!* 2012 · *Revolution Radio* 2016 · *nimrod.* 1997 ·
Rod Stewart *Vagabond Heart* 1991 (was stored as `1`) · Tommy Guerrero *Soul Food Taqueria* 2003.
Each album's track list was read first. Every one holds only that album's own tracks.

## Finding: a joint-credit album artist still owns its album (#1804)

#1526 links a song to every known member, and the album floor hides compound rows that own no
album. A compound album artist does own its album, so `Anitta/Maluma`, `Anitta/Sam Smith`,
`Natiruts/IZA` and others stay in the artists grid. Their albums do not appear under
`get_artist(Anitta)`. That is what flag 75 reported. Which member owns such an album is the owner's
call, and the options are in the issue.

## Left alone

- **Duplicate rips** of *Message From the Other Side* (opus 14 + mp3 320 14): not deleted, because
  deletes need the owner's go-ahead. Admin → Find duplicates keeps the best copy.
- **`genres.missing` (152)**: not worked. The head is the same residue every pass has triaged.
- **Remaining multi-track missing years**: VA mixes (`08 - Latin Tech…`, `01 - Pop Aguante`), Gondwana
  *Together* (year not known without a search), `CD 01`, `E D I T A R Singles`.
- **`lowInformation` tail**: Dekel (6), Avicii (5) and Ibu Selva (4) were left inconclusive in
  October. The rest are 1–2-song singletons.

## Issues filed

- **#1804**: a joint-credit album artist still owns its album, so compound rows stay in the grid.
