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
| genres.lowInformation | 249 | 142 | −107 |
| years.missing | 188 | 181 | −7 |
| years.missingMultiTrack | 17 | 10 | −7 |
| genres.missing | 152 | 97 | −55 (second batch, below) |
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

## Genre-less songs, second batch (`mode: replace`)

Worked from `list_recent_songs({missingGenre: true})`, by album cluster, from siblings only. Each
step was read back: 152 → 140 → 106 → 97.

| Songs | Artist · album | Genre written | Evidence |
| --- | --- | --- | --- |
| 10 | Jorge Cafrune · *El Chacho, vida y obra de un caudillo* (1965) | `Folclore` | *Esenciales* (opus) `Folclore`, *Yo he visto cantar al viento* (mp3 320) `South American Folk Music`, *Inolvidable* `Folk`. These are independent rips. |
| 22 | Los Palmeras · *Una Nueva Vida*, *Sin Fronteras*, *Te Va A Gustar*, *Un Toque Diferente* | `Cumbia Santafesina; Cumbia` | Seven sibling albums are `Cumbia`, and an opus straggler on *Una Nueva Vida* carries `Cumbia`. Their own album is titled *Bailando cumbia santafecina*. |
| 12 | Peteco Carabajal · *Soy Santiagueño, Soy Chacarera* | `Folclore` | The album title names the chacarera, and sibling *Andando* is `Folk`. |
| 9 | Miranda! · *Es mentira* (2002) | `Electropop; Pop` | 11 sibling albums are `Pop`. |
| 1 + 1 | Guy J · *Equinox* (Electronic-only), *Cicada* (none) | `Progressive House` | Three independent rips (*Esperanza*, *1000 Words*, *The Trees, The Sea & The Sun*) carry Progressive House. |
| 1 | Exaltasamba · *Cartão Postal* | `Samba` | `identify_song` matched at 0.97 (Exaltasamba, a pagode group). The file sits in a mis-bucketed "Jazz Fusion" VA folder. |

The remaining 97 are mostly 1-song singletons with no siblings, such as the Kauffman Brazilian-bass
singles and the VA "Jazz Fusion" bucket. Matías Aguayo *CD 01* has no year because it is a
four-track mix of tracks from different releases.

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
- **Remaining multi-track missing years**: VA mixes (`08 - Latin Tech…`, `01 - Pop Aguante`), Gondwana
  *Together* (year not known without a search), `CD 01`, `E D I T A R Singles`.
- **`lowInformation` tail**: Dekel (6), Avicii (5) and Ibu Selva (4) were left inconclusive in
  October. The rest are 1–2-song singletons.

## Issues filed

- **#1804**: a joint-credit album artist still owns its album, so compound rows stay in the grid.

## Pass 2026-11-14: composed artists

**Trigger.** One search for "Cultura Profética" returned five compound tiles
(`Greeicy/Cultura Profética`, `Jowell & Randy/…`, `Vicente Garcia/…`, `Cultura Profética/Bebo Dumont`,
`Flor De Toloache; John Legend; …`). All five are real collaborations.

**Scope (prod, read-only probe).** Artist rows with `/` or `;` in the name: **479** resolved
(`split_compound = 1`, 0 in the grid) and **10** unresolved (`split_compound = 0`, 7 with albums).
`jointCredits` reports 1 open credit (auto), so the health metric could not see any of this.

**Cause.** `LibrarySearchProvider` filtered artists by `hidden = 0` only; the grid also applies
`split_compound = 0 AND fragment_of IS NULL`. Fixed in PR #1912.
Deployed 2026-11-14 (`cbd9e6a3`); verified by running the deployed `LibrarySearchProvider` against the
prod DB read-only: `Cultura Profetica` → only `Cultura Profética`, `Kid Smoko` → only `Kid Smoko`.

**Album ownership was already right.** Every joint album (`Te Creí`, `Mantis`, `Lágrimas`, `Mi Balcon`,
`Quisiera`, `Llévame`) carries a `library_album_artists` row per member (#1813) and the web artist route
and album DTO use them. The gap was the MCP curator view: `get_artist` listed owned albums only, and
`search_library` listed resolved compounds. Fixed in PR #1913. The compound display string on an album
or song is the file's own credit, rendered as linked members; it is not an artist row.

**Curation actions.**

| Credit | Action | Evidence |
| --- | --- | --- |
| `Bob Rum/ DJ Marlboro` | split | song `Rap Do Silva` already credited to Bob Rum |
| `Kid Smoko/ Selah` | split | song `Like Me Now` already credited to Kid Smoko |
| `mc pl alves/ mc FG/ LC Santos` | split | three MC credits on the same polluted V.A. album |
| `Johnny Hammond / Seldon Powell` | split | Hammond album credit |
| `Orquesta: Caló / Cantor: Raul Beron` | split → Miguel Caló + Raúl Berón | sibling songs credited `Miguel Caló/Raúl Berón` |
| `VE/RA`, `Au/Ra`, `Axwell /\ Ingrosso` | kept whole | single acts |
| `This EP is for you. Pre-order…` | song deleted (owner's call, flag 90) | promo text as artist; `identify_song` no-match, no web match; a retag to `Unknown Artist` is refused by design (`isPlaceholderArtist`) |

**Delta.** Not measurable yet: splits apply at the next scan and #1912 is not deployed. Re-run
`SELECT … FROM library_artists WHERE (name LIKE '%/%' OR name LIKE '%;%') AND split_compound = 0`
after the next scan; expected: 0 split-pending rows.

**Result.** All five splits landed on the next scan (member rows listed, compound rows gone from search); the promo-text song was deleted and verified gone.

**Left alone.** The `V.A. - Jazz Fusion of the 70s…` album holds unrelated tracks (Brazilian funk
under a jazz title); regrouping it is the owner's call.
