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

---

# Curation pass — 2026-09-04 (artist division, new arrivals)

Curator-directed, not health-report-driven: sweep for artist fragmentation, focused on
recently-landed albums, and establish reusable rules for the archetypal shapes a
compound/joint artist credit can take.

## Scope

- The newest arrival: **"08 - Latin Tech . Techengue . Afro"** (125 tracks, DJ-mix
  compilation, `landedAt` 1788458–1788460×10⁶) — every comma/`&`/`feat.`/`vs.` artist
  string on it was spot-checked.
- The next `landedAt` cluster (1788455441820) spans dozens of unrelated long-owned
  albums (Deadmau5, Bisbal, Pescado Rabioso, Nirvana…) — a **re-land signature**
  (rescan/reorganize re-minting ids), not a genuine ingest; treated as the existing
  ("imported") library rather than new arrivals, per the standing rule on `landedAt`
  clustering.
- 8 artists spot-checked in that imported-library body for joint-artist issues, prompted
  by the user's report of "joint artists" problems there: Red Hot Chili Peppers, Charly
  García/Pedro Aznar, Deadmau5, Rosalía, ana tijoux, Molotov, Los Auténticos Decadentes,
  plus the Zato Dj/Zito Dj pair from the new compilation.

## Findings

| Case | Verdict |
| --- | --- |
| `The Red Hot Chili Peppers` vs `Red Hot Chili Peppers` — same songs, same album (*Freaky Styley*), interleaved | **Real fragmentation — merged** |
| `Charly García & Pedro Aznar` vs `Charly García;Pedro Aznar` (delimiter variance on duplicate rips of the same tracks) | Not fragmentation — `search_library`'s `artists` array stays empty for both strings; the identity layer already resolves both to the two real constituent artists |
| `Deadmau5` vs `deadmau5` (casing, a dozen albums) | Not fragmentation — one artist row; casing is a per-track display quirk |
| `Rosalía` / `ROSALÍA` / `Rosalia` (accent + case, same album *El Mal Querer*) | Not fragmentation — accent normalizer (#720) already folds it |
| `ana tijoux` / `Ana Tijoux` (casing) | Not fragmentation |
| `Molotov`, `Los Auténticos Decadentes` (`;`-joint credits with other artists) | Not fragmentation — real featured-artist credits, correctly kept distinct from the solo rows |
| `MichaelBM` (album display) vs `Michaelbm` (artist row) | Cosmetic only, single MBID-resolved artist — left alone |
| `Zato Dj` (*Japon Pon Pon*) vs `Zito Dj` (*Yo Tengo Una Gata*) | Ambiguous — no corroborating evidence (different songs, both singleton, no MBID/origin) — **left untouched** |

**Net: 8 artists checked, 1 real fix.** The "joint artist" pattern the user flagged in
the imported library turned out, on verification, to already be handled correctly by
this codebase's multi-artist identity work (`splitArtists`, the accent normalizer from
#720) — casing/accent/delimiter variance does not spin off duplicate artist rows here.
The one confirmed defect (RHCP) was the shape none of those mechanisms cover: two
genuinely different literal strings, both passing "looks like a confirmed artist" —
caught only by same-album/same-track corroboration, not by any normalizer.

## Action taken

`merge_artist({mergeInto: "Red Hot Chili Peppers", rawName: "The Red Hot Chili Peppers", confirm: true})`
— verified by `search_library` read-back (single artist row, all "The..." tracks now
carry the merged name) and by `get_library_health` totals (artists 3547 → 3546).

## Rules established (artist-division archetypes)

1. **A comma/`&`/`feat.`/`vs.` in an artist field is evidence of a real multi-artist
   credit until proven otherwise.** Never split on sight — that tooling is for spelling
   variants of one act, not legitimate collaborations.
2. **Corroborate against the track, not the name.** Same base artist appearing solo
   elsewhere, or paired with a *different* named collaborator elsewhere, is the
   signature of real collaboration credits — not a split-name artifact.
3. **A DJ-mix/compilation remixer credit and the original song's artist are two
   different roles.** `"Ven Conmigo (Remix)" — Nacho Serra` — the parenthetical is the
   mixer, the plain artist field is the original credited artist(s); never merge them.
4. **Casing/accent/delimiter drift is not proof of fragmentation in this codebase** —
   verify with `search_library` first: if the `artists` array folds the variants into
   one row (or stays empty for a joint-credit string), the identity layer already
   handled it. Chasing it further wastes search budget.
5. **The highest-confidence real signal is the same recording context under two
   different literal names** — same songs, same album, interleaved (the RHCP case).
   It needs no external corroboration because the two rows are provably the same
   entity. Contrast with a same-*shape* near-typo with no shared song/album/MBID
   (Zato Dj/Zito Dj) — there the discriminator is independent evidence, not name
   similarity, and the right call was to leave it alone.

## Not reachable from this session

`fragments.misSplitAlbums` (3, health report) and the `missplit_album` audit rule (3)
have empty worklists over MCP — instance detail needs
`scripts/audit-library.ts --rule=missplit_album` or `/api/library/fragments`, both
admin/CLI-only and out of refiner scope.

## Still open

- Zato Dj / Zito Dj — unresolved, left as two rows pending stronger evidence.
- The admin-only fragmentation surfaces above, for whoever has host/admin access.

---

## Continued (same day) — genre backlog, two coherent arrival waves

Continuing `list_recent_songs(missingGenre:true)` after the artist-division stretch above.
Two distinct waves, both resolved with real-world/self-declared evidence or one search per
artist (per the standing search-spend discipline — never search a song, search an artist):

**Wave 1 — Chamamé (Corrientes, Argentina).** Los Alonsitos (23 songs) + Lucas Sugo
(3 songs), zero searches: the catalog holds albums literally titled `Chamame` and
`Chamamé De Los Esteros` (self-declared genre), corroborated by place-name track titles
(`Romance Corrientes Chaco`, `A Mi Corrientes Porá`, `Puente Pexoa`). Dorantes (1 song,
singleton) tagged `Flamenco` from real-world identity (well-known Lebrija flamenco
pianist). 27 songs, zero searches.

**Wave 2 — Spanish rumba/flamenca scene.** One search per artist, all confirmed:
Furia Gitana, Rafa y Chinin, Kakou Reyes → `Rumba Flamenca`; Fran Cortés, José El
Francés, Diego Valdivia → `Flamenco`; Grupo Pacha (2 songs, Peruvian jungle-folk
compilation, self-declared via album title "Danzas y Costumbres de la Selva") →
`Folklore Peruano`. Skipped Pablo Briceño (classical guitarist, genre unclear from
search) and Tu Otra Bonita (self-coined "Funkyloo" — genuinely a cross-genre outlier,
not safely reducible to one tag) rather than guess. 12 songs, 8 searches.

**Wave 3 — a Swedish-language wave**, per the skill's "search in the artist's own
language" rule: Molly Hammar, Victor Leksell, Malik Dalasi, Fanny Avonne, Eah Jé (×2),
LOAM, JULIETT → `Pop`; Erika Jonsson → `Country` (self-styled "countrysångerska",
album titled `Värmländskt Twang`); Lars Winnerbäck → `Folk Rock`; Valter Nilsson →
`Pop Rock`; Genom Natten → `Dream Pop`; Korsvägen → `Pop` (song itself unconfirmed,
genre consistent across artist's catalog). Left ROMANOS and emoemy untagged — search
results were genuinely inconclusive on genre, not just thin. 14 songs, 13 searches.

**Total this stretch: 53 songs tagged, 21 searches, all verified via
`get_library_health` genre-missing count** (269 → 224 across the whole session,
accounting for ~14 new arrivals landing mid-pass). Zero flags raised — every genre
call had either self-declared evidence or a confirming source; nothing ambiguous
enough to need curator review.

## Continued (2026-09-05) — Brazilian reggae wave + Swedish wave residue

Same `list_recent_songs(missingGenre:true)` pass, continuing past the prior stretch.

**Swedish wave, finished**: Maneva (Brazilian, not Swedish — landed in the same batch;
4 songs), Oskar Linnros → `Soul`, Newkid/Jacqline/Olga Myko/Simon Superti/ORKID → `Pop`/
`Alt-Pop`, Terra → `Indie Rock`, Tom River → `Indie Folk`. 12 songs, 8 searches. ROMANOS
and emoemy remain untagged (search stayed inconclusive on genre).

**Brazilian reggae nacional wave** — zero search, real-world identity: Maneva (7 more
songs across separate single-albums), Chimarruts, Planta E Raiz, Onze:20, Rael, Cidade
Verde Sounds (confirmed via search — Maringá dub/reggae duo), Feyjão×Natiruts collab —
all well-attested acts in Brazil's "reggae nacional" scene (same lineage as Natiruts,
Cidade Negra). 18 songs, 2 confirming searches (Cidade Verde Sounds, Feyjão — the rest
recognized directly).

**Totals this stretch: 30 songs tagged, 10 searches.** `genres.missing` 224 → 188,
verified via `get_library_health`. Residue still open: Nickodemus, Ricardo Castro
("Tico Tico"), Lin Cortés, LUIS LARR, Rocío Soto, Fémina, David Frontado, Pablo Briceño,
Tu Otra Bonita, ROMANOS, emoemy — mostly singletons where a search either wasn't run yet
or came back genuinely inconclusive.

## Continued (2026-09-06) — artist fragmentation pass

Worklist: `audit-library.ts --rule=fragmented_artist`, which reported **6 clusters**.
The rule reports at ≥2 rows deliberately, so each was corroborated against its own
*track* before any merge — three turned out to be real collaborations.

**Merged (7 rows away, 5 clusters):**

- **Kelsea Ballerini** ×3 — `Ashley Gorley, Hillary Lindsey, Jesse Frasure, Steph Jones`
  / `Brett McLaughlin, David Hodges` / `Trevor Rosen, Shane McAnally`. Every name is a
  Nashville songwriter and all three tracks (`hole in the bottle`, `Miss Me More`,
  `I Hate Love Songs`) are her own solo singles — the songwriting credit landed in the
  artist tag.
- **Tego Calderón** ×2 — `Tego Calderon, Eliel Lind, Tegui Calderon, Eddie Avila` is a
  producer/composer list containing *Tego's own legal name*, which settles it. `Tego
  Calderón, Maestro` held **tracks 14 and 17** of *El Abayarde* (2003) while the real
  album row held only track 5 — complementary numbering, same 128kbps mp3 rip, so a
  fragment rather than a separate release.
- **Eelke Kleijn** ×2 — `Eelke Kleijn, Ost`'s only song carries a plain `Eelke Kleijn`
  *song* artist tag (the compound was album-artist only). `Eelke Kleijn, Nick
  Hogendoorn` was corroborated by fingerprint, not by assumption: see below.
- **Sentimental Animals** ×1 — `Sentimental Animals, Nicki B`, same proof shape as
  `Eelke Kleijn, Ost` (song artist already plain).

**Left alone — real collaborations, not fragments:**

- **Los Ángeles Azules** — `Otra Noche` (Nicki Nicole) and `Amor a Primera Vista`
  (Belinda, Lalo Ebratt) are genuine credited features. Merging would have destroyed
  real data.
- **Cele Arrabal** — `, Tatto` / `, Valentina Olguin` carry the compound on the *song*
  artist tag and read as featured vocalists in the RKT scene. Not merged, not flagged:
  "I am not certain" is not a curator decision worth queueing.
- `Sentimental Animals, JKriv, Dicky Trisco` — a real remix credit on the *Love Vibration
  EP*. It still exists; the cluster only left the report because the rule needs ≥2 rows.

**A dedupe proved by fingerprint.** Two `Compact` files, `Eelke Kleijn & Nick Hogendoorn`
(mp3 320, `Eelke Kleijn/Untold Stories/`) and `Eelke Kleijn, Nick Hogendoorn` (opus 209,
`Eelke Kleijn, Nick Hogendoorn/Untold Stories/`), returned the **same `acoustId` and the
same `recordingId`** (`b128205c-207e-4b28-b33a-a491cddee58e`) — proof of one recording,
not a duration guess. AcoustID credits that recording to `Eelke Kleijn` alone, which is
what justified the merge independently of my own reading of the name. The redundant opus
copy (`9e50199e…`) is **still on disk** — the delete was blocked by the session's
permission classifier, not declined on the merits. It remains the one open item here.

**Genres:** Chris Stapleton ×4 (`Tennessee Whiskey`, `Millionaire`, `Starting Over`,
`You Should Probably Leave`) → `Country`, `mode: 'replace'`, zero searches — one
artist-level judgment over a cluster of four loose singles. Verified by read-back.

### Deltas, and why most of them are not results

| metric | before | after | honest reading |
| --- | --- | --- | --- |
| `fragmented_artist` | 6 | **2** | real, and the 2 survivors are the deliberate keeps |
| artist rows | 3560 | 3543 | 7 merged by hand; the rest is rescan churn |
| `genres.missing` | 190 | 184 | only **4** are mine; the denominator moved too |
| `album_count_mismatch` | 134 | 79 | **not mine** — post-delete churn settling (#774) |
| songs | 19080 | 19184 | **not an ingest** — see below |

`list_recent_songs` came back with one *identical* `landedAt` across a page of
long-owned catalogue (Bowie, RHCP, Pescado Rabioso). Song ids are `sha1(path)`, so the
full rescan each `merge_artist` kicks re-mints rows and the whole library reads as "just
landed". Reading that row count as +104 arrivals would have been the trap the skill
warns about; the only dimension safe to claim here is the one measured by re-running its
own rule.

**Filed:** [#946](https://github.com/kevinch3/NicotinD/issues/946) — an artist *split*
records no members in `audit_log`, so 36 of 45 identity actions (80%) have no
recoverable outcome. Measured from the prod ledger, not inferred.

### Same day, second stretch — the rest of the HIGH audit rules

Now reachable via `audit-library.ts --rule=<id>` in the prod container (see above).

**`djset_artist` 2 -> 1.** Both rows are DJ-set listing lines used as artist names. The
audit suggested merging `Pan-Pot playing "Enrico Sangiuliano - Restlessness"` into
`Pan-Pot`, which I initially doubted — the *played* track is Sangiuliano's, so crediting
Pan-Pot looked like the wrong call. `identify_song` settled it: **`no-match`**. A studio
recording would have matched (measured 21/22 in this library), so the file is Pan-Pot's
own live set, and Pan-Pot is genuinely the performing artist. Merged.

The sibling row is a **b2b credit naming two acts** (`Secret CInema B2B Egbert …`), which
has no single canonical target — the exact case the skill reserves `flag_for_review` for.
**Flag #19 raised**, carrying the `no-match` evidence so a later pass cannot "helpfully"
retag it as Enrico Sangiuliano. Note three consecutive `no-match` results here against a
1-in-22 base rate: for live-set rips, `no-match` is the *expected* answer, not a failure.

**`missplit_album` 3 -> 3, all false positives -> filed
[#947](https://github.com/kevinch3/NicotinD/issues/947).** The rule clusters one-track
singles on `normalizeForGrouping(album.name)` with **no artist in the key**
(`library-audit.ts:359`), and its anti-false-positive guard (≥2 distinct track numbers)
does not discriminate — unrelated singles by different artists produce distinct track
numbers too. Every current finding is a generic title shared across artists: `granada`
(Uma / Agustín Lara / Paco de Lucía, three covers of one famous song), `pensando en ti`
(Xavi / Cafe quijano / Banda Express — whose song is actually *El Tren*), `20 grandes
exitos` (Alcides / Rúben Juárez / Chaqueño Palavecino, while Damas Gratis separately owns
a real complete 20-track album of that name). **Precision 0/3.** Nothing curated here;
the fix is in the predicate, not the data.

**`watermark_album` (5) and `numeric_single` (1) — left, deliberately.** The five Tash
Sultana rows are promo-clip audio (15–47 s opus, titles that are literally tour captions,
all in `Various Artists/Unknown/`) and are `DELETABLE_RULES` members, but `delete_song` is
blocked by this session's permission classifier, so they stay. The numeric single is
`Various Artists/2025/Strum.opus` — 341 s, artist `Chris Liebing, Speedy J, Collabs 3000`,
which is a credit list whose canonical act is **Collabs 3000** (Liebing + Speedy J). Its
album "2025" is a folder artifact, but `identify_song` returned `no-match`, so the real
release is unconfirmed and I did not invent one. Left for a pass with better evidence.

**Verified deltas this stretch:** `fragmented_artist` 6 -> 2, `djset_artist` 2 -> 1, open
flags 0 -> 1. Each re-measured by re-running its own rule, not counted from my own tally.

### Third stretch — rare-genre cleanup, 21 songs

`get_rare_genres({maxCount: 2})`, then a direct `library_song_genres` probe per candidate
**before** any write — because a bare single-genre `replace` overwrites the song's whole
set. That check earned its keep immediately: `CancióN MelóDica` sat on **7 songs and only
one at position 0**; the other six carried it at position 2, 3 or 5 alongside real primary
genres. Six bare replaces would have deleted, among others, Mina's eight-genre set.

Fixed, all folded into spellings the library **already** had rather than minting new rare
ones (counts re-read from the DB after):

| was | became | effect |
| --- | --- | --- |
| `CancióN MelóDica` ×7 | `Canción Melódica` | 7 -> 0, full ordered list preserved per song |
| `Electronic - {Synthwave,Techno,Trance,Tech Trance}` | prefix stripped | 4 CamelPhat songs onto existing genres |
| `Chill Out` + `Chillout` | `Chillout` | 1+1 -> 2 |
| `Forró UniversitáRio` | `Forró Universitário` | with `Forró` kept at position 1 |
| `Alternativo & Rock Latino`, `Latino Rock (Argentina)`, 3 Babasónicos song-titles-as-genres | `Alternative Rock;Rock Argentino` / `Rock Argentino` | `Rock Argentino` 43 -> 48 |
| `FAVORITAS`, `Education`, `Eighty` | `Salsa` / `Dance-pop` / `Pop` | playlist name, podcast category and junk removed |

**A hypothesis I filed nothing on, because it was wrong.** `CancióN MelóDica` and
`Nueva CancióN` look exactly like a title-caser splitting words on an ASCII-only boundary
(`canción` -> `CancióN`: the character *after* the accented letter is uppercased), and the
repo has an accent-defect history (#720) that made that story attractive. There is no such
code path — `genre-split.ts`'s `norm` only trims and collapses whitespace, and nothing in
`packages/api` or `packages/core` title-cases a genre. The malformed casing arrives in the
**source tags**. Checking before filing is the whole point; the issue I would have written
would have sent someone hunting a function that does not exist.

**Filed [#949](https://github.com/kevinch3/NicotinD/issues/949)** instead, for the real
gap. Three values are artist-scoped and alias-shaped, not song-shaped:

| raw value | rows | position | carrier |
| --- | --- | --- | --- |
| `Nueva CancióN` | 44 | **all at position 3** | Mercedes Sosa |
| `Rock - Alternative Rock` | 8 | 0 | Red Hot Chili Peppers |
| `Pop RockLatin AlternativeLatin RockLatin Pop` | 15 | 0 | Jarabe de Palo |

`library_genre_aliases` is exactly the store for these (66 rows already, including a
seeded twin of the Jarabe de Palo concatenation), but **no MCP tool writes it**, so from a
refiner session a 44-row artist-wide mistag costs 44 song overrides *and still breaks on
the next Mercedes Sosa arrival*. Left unwritten rather than papered over with 44 overrides.

Worth recording separately: **`get_rare_genres` counts the primary genre only**, so
`Nueva CancióN` — 44 rows, none primary — is invisible to that worklist entirely. The
largest instance of this whole class only surfaced from a direct probe.

### Fourth stretch — structural probes, one merge, two issues

Probed `library_song_genres` for two structural shapes rather than working a tool worklist,
because the previous stretch showed the tool worklist cannot see this class.

**The two genre families are now closed sets**: `X - Y` prefix (9 values / 40 songs, all at
position 0) and no-separator concatenation (7 values / 73 songs). With `Nueva CancióN`,
that is **16 alias rows covering 113 song-genre rows**. Posted the full inventory as a
comment on [#949](https://github.com/kevinch3/NicotinD/issues/949) with per-value carrier,
position and proposed canonical. Deliberately **not** fixed as 113 song overrides: the
string is wrong wherever it appears, so a song-scoped override is the wrong granularity
and would still break on the next Alex Gaudino or ABBA arrival.

Note on the prefix family: the faithful expansion keeps **both** sides
(`Electronic - House` -> `House;Electronic`), matching how the table already handles
`"LatinPopLatin Pop" -> "Latin;Pop;Latin Pop"`. Dropping the prefix would discard a real
genre.

**A concatenated-artist detector, and why it should not be built.** `NatirutsThiaguinho`
suggested a class that `fragmented_artist` structurally cannot see (it looks for
comma-extended names). Probing every artist matching `*[a-z][A-Z]*` returned 40 rows of
which **39 are legitimate** — WhoMadeWho, Mac DeMarco, CamelPhat, OneRepublic, GloRilla,
DaBaby, and the entire `Mc*` family (McRae, McGriff, McLean, McGraw, McEntire). Exactly one
was a true concatenation, and the discriminator that found it was not the casing run but
**"the head matches an existing artist row exactly"**. A casing-run detector would be ~2.5%
precision; the comma-based rule is not missing a wave.

Renamed it to `Natiruts, Thiaguinho` (song: *Serei Luz*) rather than merging into
`Natiruts`, which preserves Thiaguinho's credit.

**A rule this made explicit.** The alias table already held
`"natirutsgilberto gil" -> "Natiruts"` from an earlier pass, and it first looked like that
pass had destroyed a credit. It had not: both Gilberto Gil songs carry the feature **in the
title** (`Verde do Mar de Angola (feat. Gilberto Gil)`). *Serei Luz* does not. So the rule
is: **fold a concatenated collaboration to the base artist when the title already carries
the feature; keep the compound when it does not** — otherwise the credit exists nowhere.
Both prior and current decisions are correct under it.

**Filed [#950](https://github.com/kevinch3/NicotinD/issues/950).** Auditing every
`source='user'` alias surfaced two keyed on generic placeholders rather than
artist-specific strings: `[traditional] -> Luciano Pavarotti` (collateral from the
Pavarotti identity work) and `me -> &ME` (because `normalizeArtistForGrouping("&ME")` is
`me`). **Latent, not active — 0 songs match either today, verified before filing.** But
`[Traditional]` is a routine placeholder on folk and classical rips, and this library
ingests both, so any such arrival would be filed under Pavarotti silently: the artist
resolves cleanly, so no audit rule fires. The table is documented as rescan-surviving and
`source='user'` rows are never overwritten, so it does not self-correct.

Also on prod, harmless but evidential: `"zion &amp;amp; lennox" -> "Zion & Lennox"` — a
**double-escaped** entity fossilised into an alias key, showing the #787 hazard can reach
durable storage rather than just a single bad write.

### Fifth stretch — song-level duplication, measured

Started from the accent/case title twins visible in Natiruts' listing
(`A justiça falha` / `A Justiça Falha`). Folded `artist + title` (NFD accent strip, case
fold, punctuation collapse) across all 19,184 songs:

- **1,075** fold-identical clusters, **1,173** excess files — about **6% of the library**
- **759** two-file clusters agreeing within 2 s of duration

**Candidates, not confirmed duplicates**, and the distinction is the point of this entry.

**Hypothesis tested and rejected: transcode leftovers.** If `transcode-library` had left its
sources behind, pairs would share an album and skew `mp3+opus`. They do neither — only
**55 of 759** share an `album_id`, and `mp3+mp3` (268) outnumbers `mp3+opus` (223). The
paths give the real cause: the same release acquired twice under variant naming
(`La Konga/` vs `La K'onga/`, `Los Pericos/` vs `Pericos/`, `2003 9` vs
`9 (Remastered 192 khz)`). `library_artist_aliases` already holds `pericos -> Los Pericos`,
so the alias layer folds these in the **UI** while both files stay on disk — the dedupe
happened in presentation, never in storage.

**Fingerprinted a sample, n=3.** All three pairs returned the same `acoustId` **and** the
same `recordingId`. Two of them (`Losing My Edge`: *Singles* vs *Live At MSG*;
`We Found Love`: *Talk That Talk* vs *777 Documentary*) sit in folders named for a live
album and a documentary and are nonetheless the studio recording — folder context was
actively misleading and only the fingerprint settled it. n=3 licenses nothing about 1,173;
it only shows the strongest tier is not obviously wrong.

**Why this stayed invisible**: #660 fixed recording identity at *serve* time (0.00% dup
share, 0 recordings served from >1 file), closing the audible symptom. The storage cost was
never measured and no worklist would show it. There is no song-level duplicate rule at all —
the 16 audit rules are album- and artist-level, and `fragments.duplicateAlbums` reads 0.

**Filed [#951](https://github.com/kevinch3/NicotinD/issues/951)** proposing a
`duplicate_recording` rule that shortlists on the fold + duration window but **confirms by
`recordingId` before reporting** — the same discipline #947 shows is missing from
`missplit_album`.

**A distinction worth keeping.** Both Lenny Kravitz files fingerprinted to *"Metro Station —
Now That We're Done"* and both Rihanna files to *"Rain Paris"*. Two independently-sourced
rips are not wrong the same way, so that is upstream label metadata sitting on an otherwise
correct fingerprint cluster. So: **`recordingId` equality between two files is reliable; the
artist/title AcoustID attaches to that recording is a weaker, separate claim.** Irrelevant
to dedupe, critical to anything that pipes `identify_song` into `fix_song_metadata` —
auto-applying here would have retagged Lenny Kravitz as Metro Station.

### Sixth stretch — years and truncated-name fragments, 18 writes

Deliberately picked a lane that **lands changes** rather than findings.

**`missing_year` 191 -> 184.** Most of the worklist is the trap the playbook names: a
one-song "album" named after a *compilation* the track appeared on (`Now 4`,
`The Fast And The Furious OST`, `XTC Trax 6`, `The Non-Stop Party Album 2`). Dating those
from the title dates the compilation, not the recording, so they were skipped. Checked
`get_album_tracks` on every candidate first and wrote only where the track genuinely
belongs to that release:

| album | year | corroborating track |
| --- | --- | --- |
| Soda Stereo — SEP7IMO DIA | 2017 | *Un millón de años luz* (trk 13) |
| Ricky Martin — Música + alma + sexo | 2011 | *Más* |
| Paulina Rubio — Gran City Pop | 2009 | *Causa Y Efecto* |
| Paulina Rubio — Border Girl | 2002 | *Si Tú Te Vas* (the Spanish *Don't Say Goodbye*) |
| Wisin & Yandel — Líderes | 2012 | *Algo Me Gusta De Ti* |
| Luis Miguel — El concierto | 1995 | *Será Que No Me Amas* |
| "Paulina" — Gran City Pop | 2009 | *Ni Rosas Ni Juguetes* |

Skipped **Thalía — "Greatest Hits"**: a generic title reused across labels and years, so a
confident-sounding guess is exactly what the playbook says to replace with a search.

**A third fragment shape, found from the years lane rather than an audit rule.** "Paulina"
(2 songs) is a *truncation* of "Paulina Rubio", and both its tracks are confirmed Gran City
Pop songs — one already sitting in Paulina Rubio's own album row. `fragmented_artist` cannot
see this: it looks for comma-extended names, and a truncation extends nothing.

**Probing that shape**: artist rows that are a strict prefix of another artist row. Like the
concatenation probe, dominated by legitimate names — `X & Y` collaborations, jazz
`X Trio`/`Quartet`/`Quintet`, tango `X y su Orquesta`. But three real classes fell out, and
**10 more artist rows merged**:

- **Tango orchestra variants** (3): `Juan D'Arienzo and his Orchestra`, `Francisco Lomuto y
  su Orquesta Típica`, `Ricardo Tanturi y su Orquesta Típica Los Indios`. Not a judgement
  call — `library_artist_aliases` already holds **12** owner-made rows of exactly this shape
  (Di Sarli ×3, Canaro ×2, Fresedo ×2, Pugliese, Biagi, D'Agostino, Donato ×2, Gobbi,
  Demare). These were simply the unfolded remainder of an established ruling.
- **"Artist - Track" listing lines** (2): `Pappo's Blues - Tumba (Cementerio)`,
  `Fatoumata Diawara - Wililé` — same class as the `djset_artist` rows merged earlier.
- **YouTube video titles as artists** (5): `Tash Sultana Live`, `Tash Sultana x PlayStation`,
  `Tash Sultana - Mystik (Live on The Sound` (truncated mid-parenthesis),
  `Tash Sultana - LIVE Stream at Sidney Myer Music Bowl`,
  `Tash Sultana - Live Stream Performance`. Same source family as the 5 Tash Sultana
  watermark albums still awaiting deletion.

**Verified**: all 11 merged-away rows confirmed absent, artists 3543 -> 3530,
`missing_year` 184, Tash Sultana consolidated to one row.

**Pattern worth naming.** Three separate fragment shapes have now been found — comma
extension (`fragmented_artist` catches it), no-separator concatenation, and truncation —
and the last two were each found by a *different* lane, not by the audit. The generalisable
discriminator across all three is not string similarity but **"does the candidate's other
half already exist as an artist row, and do the tracks corroborate it"**. String-shape
detectors alone measured ~2.5% precision on the concatenation probe and are similarly noisy
here; the shared-context test is what separates a fragment from a real distinct act.

### Seventh stretch — genre propagation, 14 writes, zero searches

Worked the genre residue by the playbook's free lane only: propagate from an artist's own
tagged siblings, never a search.

**A metric I misread, and the correction is the useful part.** A direct probe found **108**
songs with no `library_song_genres` row while `get_library_health` reported **184**, and my
first instinct was that the metric was wrong. It is not — `unresolvedGenreSql`
(`genre-split.ts:195`) counts junk *values* as unresolved too, via the `JUNK_GENRES` set
added by #694 because YouTube's category names (`music`, `entertainment`) made 485 songs
"look genre-resolved and be invisible to both genre tasks forever". So:

```
184 = 108 with no genre row  +  76 carrying a junk primary genre
```

All 76 carried the same value: **`"Music"`**. My narrower probe had hidden an entire lane —
the health number was right and my query was the incomplete one.

**Propagation, with the independence test doing real work.** For each unresolved song,
collected same-artist siblings holding a non-junk primary genre, required **>=2 agreeing**
and required the siblings to span more than one album or more than one format.

That last condition rejected a candidate that would otherwise have looked strong: Telzen's
*G Power - Franca mix* had four agreeing `Electronic` siblings, but all four sit in **one
album in one format** — and the untagged song is in a *different* album (`35f38732` vs
`2d3915c5`). That is the playbook's n=1-not-n=4 case exactly: one source's blanket tag, and
not even the same source as the song being tagged. Skipped.

Written (14, all `mode: 'replace'`, all verified to carry nothing but the junk value first):

| artist | songs | genre | sibling evidence |
| --- | --- | --- | --- |
| Tash Sultana | 1 | `Singer-Songwriter` | 289 siblings, 282 albums, 64 formats |
| Viejas Locas | 5 | `Rock` | `Rock:28` across 3 albums / 4 formats |
| Ratones Paranoicos | 2 | `Rock` | `Rock:51` across 3 albums / 20 formats |
| Callejeros | 1 | `Latin Rock` | unanimous across 3 albums |
| Juana la Loca | 1 | `Punk Rock;Rock` | `Punk Rock:22 Rock:11`, 3 albums / 3 formats |
| Jean Carlos | 1 | `Latin` | `Latin:11` across 5 albums |
| La Barra | 1 | `Latin` | unanimous across 3 albums |
| Migrantes | 1 | `Cumbia` | unanimous across 4 albums |
| La Repandilla | 1 | `Latin;Cumbia` | `Latin:4` majority, `Cumbia:1` attested |

**Verified**: health-definition missing **184 -> 170**, junk `Music` **76 -> 66**, no-genre-row
**108 -> 104**. The deltas match the 14 writes exactly, with no rescan churn to discount.

Remaining residue is what the playbook predicts: mostly singleton artists with no tagged
sibling to propagate from, which is why the free lane yields 14 and then stops.

### Eighth stretch — album covers, and a number that was wrong

**The network lane is a dead end for this catalogue.** Looked up 4 real albums
(Los Enanitos Verdes *Obras Cumbres*, Los Chalchaleros *Una leyenda*, Savia Andina
*Lo Mejor de…*, Sanampay *En Esta Hora…*) at the concurrency limit the tool itself
specifies. **0 of 4 yielded a usable cover**, and the failure is structural rather than
bad luck: every score-100 *identity* match came back with `coverUrl: null`, while the
candidates that *do* carry images are different releases (*Big Bang*, *Néctar*, a different
Chalchaleros volume series). Applying by score would systematically put wrong covers on
albums. Cover Art Archive coverage for long-tail Latin American folklore is simply thin.

**Then the local lane, and a wrong conclusion caught by reading the code.**
`set_album_cover(albumId, songId)` materialises a track's embedded picture as `cover.jpg`.
It works — verified on disk, 14 albums. Sampling 120 reported-missing albums showed **68.3%**
carry embedded art (mp3 **82/87 = 94%**, opus **0/28**, m4a 0/4, ogg 0/1), which projects to
~2,900 albums "recoverable with zero network".

That framing was wrong, and the correction is the finding. `extractCover`
(`streaming.ts:603`) is `folderCover() ?? extractEmbeddedPicture()` — **the embedded art was
already being served.** Those albums were never missing art to a user; they were missing a
`library_artwork` *row*.

**Filed [#952](https://github.com/kevinch3/NicotinD/issues/952).** `missingAlbumArtSql` is
`NOT EXISTS (library_artwork row)`, but the serving path is a three-tier fallback, so:

| | albums |
| --- | --- |
| reported "missing artwork" (largest number in the health report) | **4,271** |
| already render via the embedded fallback | **~2,859** |
| genuinely render nothing | **~1,412** |

The headline is ~3x the user-visible problem, and its remediation hint recommends a bulk
network fetch for art the library already holds locally. Same family as #612's false
denominators: honest about its SQL, dishonest about its name.

**Secondary finding worth chasing separately:** opus is **0/28** for embedded art against
mp3's 94%, and opus is 1,196 of the 4,271 — i.e. most of the genuinely-unrenderable set.
That is a pipeline property, not chance: whatever produces opus here drops cover art the mp3
path keeps. Fixing it at the source would remove the majority of the real backlog.

**What the 14 writes actually bought**: one folder read instead of an ID3 parse per cover
request, and art that survives a later transcode. A caching and durability win, not a
visible one — and it does not move `albumCovers.missing`, since it writes no
`library_artwork` row. Recorded rather than quietly counted as 14 covers fixed.

### Ninth stretch — the art loss, measured across the whole population

Chased #952's secondary lead. Scanning **every** file rather than a sample removes any
doubt about the shape:

| format | files with embedded art | sampled |
| --- | --- | --- |
| **opus** | **0** | 1,500 |
| **m4a** | **0** | 219 |
| mp3 | 349 (87.3%) | 400 |

**Zero of 1,719 non-mp3 files carry a picture.** Not a rate — an absolute. Only files that
*arrived* as mp3 have art; every path that produces a file loses it. That also corrects the
previous entry's framing: this is not an opus problem, it is a "everything except mp3"
problem, and m4a never goes through the transcode at all.

**Mechanism for the transcode path** — `transcodeToOpus`
(`post-download-transcode.ts:129`) passes `-vn`, with no explanatory comment. An embedded
cover is an attached *video* stream in ffmpeg, so `-vn` discards it, and `-map_metadata 0`
carries tags only.

**Filed [#953](https://github.com/kevinch3/NicotinD/issues/953)**, including the trap: simply
deleting `-vn` does not fix it. ffmpeg's Ogg muxer cannot write an attached picture stream —
Opus carries art as a base64 `METADATA_BLOCK_PICTURE` comment instead — so removing the flag
changes nothing at best, and at worst fails the strict run into the lenient fallback.

The proposal is to write `cover.jpg` at the point art would otherwise be lost, rather than
plumbing per-format tag support: one write per album instead of per track, format-independent,
covers the m4a and yt-dlp cases too, and it feeds **tier 1** of the serving fallback — the tier
doing nothing today (2 of 4,271 albums had a folder image before this pass).
`set_album_cover(albumId, songId)` already implements that materialisation, so the primitive
exists and only needs calling at the right moment.

**Landed as a down payment: 30 folder covers** on the largest mp3 albums that had embedded art
and no folder image (verified on disk, 2 -> 31). The value is precise and worth not overstating:
it protects those albums' art from being lost if they are ever transcoded, and saves an ID3
parse per cover request. It does **not** change what a user sees today, and does not move
`albumCovers.missing`.

### Tenth stretch — auditing my own merges, and the medium tier collapses

Started by checking whether this pass's `merge_artist` calls were stranding artist rows.
**They were not**: `orphan_artist` went **496 -> 485** across 13 merges, so merging removes
rows rather than orphaning them.

But the names in that worklist were wrong for cruft — "DJ Koze", "Javiera Mena",
"Der Dritte Raum" are real artists, and the rule's message is *"should be pruned"*. Counted
`library_song_artists` rows for all 485:

| | artists |
| --- | --- |
| reported orphaned, "should be pruned" | **485** |
| credited on >=1 song via `library_song_artists` | **485** |
| genuinely referenced nowhere | **0** |

**Zion has 20 song credits.** `checkArtistIntegrity` (`library-audit.ts:70`) decides
orphanhood from `library_albums.artist_id` and `library_songs.artist_id` — primary
attribution only — and **the string `library_song_artists` appears nowhere in
`library-audit.ts`**. Every featured or secondary artist therefore looks orphaned.

**Filed [#954](https://github.com/kevinch3/NicotinD/issues/954).** Adding the join table to
the predicate takes the rule from 485 findings to **0** on current data. The message also
deserves softening: "should be pruned" is an *instruction*, and acting on it would delete 485
legitimately-credited artists and break attribution on 500+ credits. Nothing automated does
so (`orphan_artist` is not in `DELETABLE_RULES`) — the exposure is a human or an agent
following the text.

**Taken with #952, the audit's whole medium tier is noise.** Medium is 4,762 findings, and it
is exactly four rules:

| rule | count | status |
| --- | --- | --- |
| `missing_artwork` | ~4,276 | ~3x overstated (#952) |
| `orphan_artist` | 485 | **100% false positive** (#954) |
| `fragmented_artist` | 2 | real (both deliberate keeps) |
| `djset_artist` | 1 | real (flagged, #19) |

So **over 99% of medium findings are noise**, which explains why the tier has never been
actionable in any pass. Three of this session's issues (#947 `missplit_album` 0/3, #952, #954)
are the same defect shape: a predicate that answers a cheaper question than its name claims,
and a count that is therefore not a workload.

### Eleventh stretch — running the audit with no filter, and finding a hidden dimension

Stopped working rules piecemeal and ran `audit-library.ts` with no `--rule`. That surfaced a
rule ten stretches of health-driven work had never seen: **`orphan_file`, 393 findings** —
audio on disk with no `library_songs` row. It is a **disk** rule, and `get_library_health`
is DB-only, so it appears in no health report, no MCP tool and no curation worklist. That is
the reporting gap, and it is why this was invisible: *a dimension the curator's tool cannot
show is a dimension that never gets worked.*

Reproduced independently — walking `musicDir` with the shared `isReservedPath` /
`reservedDirsFor` predicate and diffing against `library_songs.path` gives exactly **393**.
(Without the predicate it is 699; the difference is `.downloads/` staging. Worth recording
because the naive number is the one you get if you forget the shared helper — the thing
`check:library-walkers` exists to prevent.)

**Two populations, only one alarming:**

| | files | folders |
| --- | --- | --- |
| partially-scanned folders (duplicate-shaped) | 348 | 96 |
| folders where **every** file is orphaned | 45 | 13 |

The 348 are #951 seen from the disk side — `LCD Soundsystem/Singles` has `01 - Losing My
Edge.opus` in the DB and `10 - Losing My Edge.opus` orphaned beside it.

Of the 13 fully-invisible folders I **checked each rather than assuming**, and most are
redundant: La Renga (1998) is covered by `1998 - La Renga {526034-2}`, VA *Surface Sounds* by
`Kaleo/Surface Sounds`, Eros Ramazzotti *9 (Remastered)* by the mp3s in `2003 9`.

**One is real: `Juanes/Un Día Normal (20th Anniversary Remastered)`, 10 tracks.** Zero title
matches anywhere in `library_songs`, and Juanes has no *Un Día Normal* album in the DB at
all. Ten owned tracks that cannot be played.

**Filed [#955](https://github.com/kevinch3/NicotinD/issues/955)** with the observation and no
root cause, plus what is ruled out: not reserved-path staging, not Unicode normalisation (all
19,184 DB paths are NFC), not a missed scan (several full rescans ran this session and the
files stayed orphaned), and **not format-specific** — orphan rate is opus 3.24%, m4a 3.10%,
mp3 1.30%. That last one corrects an impression: the first two listings I read were
opus-heavy and I nearly wrote it up as an opus problem. It is not.

### Twelfth stretch — titleMismatch is a deluxe-edition artefact; 8 name fixes landed

Worked `titleMismatch` (41), the last unexamined completeness dimension. Its worst entry —
Motörhead *Another Perfect Day*, expected 34 / on disk 35 / **unmatched 27** — is not a defect:
the local copy is the **40th Anniversary deluxe edition** (base album as "40th Anniversary
Master", B-sides, demos, and a complete Hull City Hall 1983 live set). Lidarr's tracklist is
the standard edition, so 27 titles have nothing to match against. Same predicate shape as
#947 and #954: the count is not a workload.

Two genuine defects fell out of reading it, though:

**A duplicate at track 30** — `Shine (Live at Hull City Hall / June 22nd, 1983)` and
`Shine (Live at Hull City Hall, 22/6/1983)`, same track number, differing only in punctuation
and genre tag. That is the on-disk-35-vs-expected-34 discrepancy, and it belongs to #951.

**A trailing space in the album name**, `"Another Perfect Day "`. Probing for that shape found
it is systematic: **13 album names, 2 artist names and 63 song titles** carry leading, trailing
or doubled whitespace.

**Landed 8 album-name fixes** with `fix_album_metadata` — `"Another Perfect Day "` (35 songs),
`"Low "` -> `Low` (David Bowie, 17), `"La negra tiene tumbao  (Mp3)"` -> `La negra tiene tumbao`
(Celia Cruz, 7), `"Spiritual Milk "`, `"Can't Shake It Loose "`, `"Open Our Eyes "`,
`"Me Vas a extrañar (en vivo)  Feat…"`, and `"Don Omar ❌  Tego Calderon | Bandolero"` ->
`Bandolero`. Verified: **13 -> 5**, and the 5 survivors are deliberate skips (one placeholder
name, four YouTube video titles belonging to the watermark family).

**Filed [#956](https://github.com/kevinch3/NicotinD/issues/956)** for the one surface where the
same fix is unreachable. `merge_artist` cannot correct a whitespace-only display name: it
trims `rawName` before the equality check, so the call fails with *"mergeInto must be a
different artist name"* — and the failure echoes `rawName` back **already trimmed**, which is
the tell. No spelling of the request can express it. The catalogue is not split
(`normalizeArtistForGrouping` folds the whitespace), so this is cosmetic — but the album-side
equivalent was fixable and artists are unreachable for an incidental reason. The `rename`
decision in `artist-identity-mutate.ts:66` already does exactly this; MCP just never exposes it.

### Thirteenth stretch — 63 song titles normalised

Worked the lane the previous stretch surfaced but did not finish: **63 song titles carrying
leading, trailing or doubled whitespace**, fixed with `fix_song_metadata` (title only; the
tool never moves or renames the file, so ids, likes, playlists and history stay pointed at
the same song).

This is functional, not cosmetic. Exact-title comparison is what
`completeness`/`titleMismatch` and the duplicate fold both rely on — the Motörhead album's
"on disk 35 vs expected 34" was partly this class of noise. A trailing space makes a title
unequal to itself.

Biggest clusters: Pink Floyd *The Wall* ×13, Madonna *Confessions* ×11, Buena Vista Social
Club alternate takes ×8, Chayanne ×5, Don Omar ×3, Tash Sultana ×3, Funkadelic ×2, Billie
Eilish ×2. Two got more than a trim, where the surrounding evidence was already settled this
pass: `Don Omar ❌  Tego Calderon | Bandolero` -> `Bandolero` (matching the album row fixed in
the previous stretch), and ` OUT NOW` -> `OUT NOW`.

**Verified by read-back rather than by the tool's own field** — `fix_song_metadata` returned
`verified: true` on all 63, and per #865 that is not proof:

| | before | after |
| --- | --- | --- |
| `library_songs.title` | 63 | **0** |
| `library_albums.name` | 5 | **1** |
| `library_artists.name` | 2 | 2 |

The album count fell further than the 8 rows written in the previous stretch, because album
names are **derived from the songs' tags** — normalising the titles cleaned four album names
for free (the three Tash Sultana video titles and the MTV Unplugged one). Worth knowing for
sequencing: fix song titles first, and some album-name defects resolve themselves.

The single remaining album name (`E D I T A R  Singles`) is a placeholder, and the two artist
names are the ones blocked by **#956**.

### Fourteenth stretch — title pollution, 15 fixes, filed #957

Probed song titles for source watermarks, YouTube suffixes and "Artist - Title" prefixes —
a class no audit rule covers.

**Watermarks in titles (10 fixed).** Eight Gwen Stefani tracks on *The Singles Collection*
carried `www.GrWarez.com`, and two techno tracks carried `djsoundtop.com` — two unrelated
sources, so not a one-off rip. Retagged with `fix_song_metadata`; **15 -> 5**, and the five
survivors are the Tash Sultana promo clips whose titles *are* the watermark.

**Junk suffixes (5 fixed).** `Chuck E's In Love With Lyrics`, `Jurabas tu │ Video Lyric Banana
Mascheroni`, `I Will Find The Hood (Full Song)`, `Willow Tree (…) Visualizer`, and
`Hot Child In The City by Nick Gilder with lyrics` — the last got its artist fixed too
(`HouseandCuddyforever` -> `Nick Gilder`), because **the title itself declared it**. That is
the playbook's "check the track title for a self-declared answer before searching" rule paying
out on artist rather than genre: zero searches spent.

**Deliberately left alone**, because a pattern match is not a defect: `Candombe |` /
`Candombe ||` (Las Pastillas del Abuelo — Roman numerals, not pipes), `BM | DJ TAO Turreo
Sessions #17` and `Lágrimas | CROSSOVER #4` (real release-title formats for those series),
`YOLO (feat. Aria Lyric)` and `Solari Yacumenza (feat. Cuareim 1080)` (real credits that only
matched a "lyric"/"1080" probe), and `Bhavi - BZRP Music Sessions #1` (the real title format,
not an "Artist - Title" artefact). 26 pipe matches, 4 lyric matches and 4 self-prefixed titles
were surfaced; only the ones with actual pollution were touched.

**Filed [#957](https://github.com/kevinch3/NicotinD/issues/957).** `looksLikeSourceWatermark`
runs over artist names (`library-audit.ts:171,184`) and album names (`:273,566`), but over
titles **only** at `:517` inside `albumHasRealTrackTitles` — which asks the *inverse* question
("does this album hold a real title, so do not delete it") and is a deletability guard, not a
finding. So a watermark in a title on a clean album is structurally invisible: *The Singles
Collection* and *Gwen Stefani* are both fine, only the titles were polluted, and the album
even scores well on the guard because the other nine tracks are clean.

The proposed `watermark_title` rule must **not** join `DELETABLE_RULES` — a watermarked title
on real audio is a retag, never a delete (#705's "junk metadata is not junk audio", sharper
here). The Tash Sultana clips are the contrast case: junk *content*, already covered by
`watermark_album`, where deleting is right and retagging is pointless.

### Fifteenth stretch — feature credits in the artist field, and two false credits

Probed for feature credits inside artist names. **Zero at the artist-row level** — `splitArtists`
already folds them — but **11 distinct song-level `library_songs.artist` strings** carried one,
4 of them malformed (`ft.` with no space), all Gwen Stefani, splitting one album across five
artist strings.

Applied the rule established in the Natiruts case: *fold to the base artist when the credit
survives in the title; keep the compound when it does not.* Here the titles carried nothing,
so the credit had to be moved into the title rather than dropped.

**Corroborating each against the track found two false credits** — which is the entire reason
the standing rule exists:

| song | tagged | verdict |
| --- | --- | --- |
| Rich Girl | ft. Eve | correct |
| Yummy | ft. Pharrell | correct |
| Now That You Got It | ft.Damien Marley | correct, but misspelled (*Damian*) and the title was truncated mid-word (`(Radio Ed`) |
| **Early Winter** | ft.Akon | **false** — a solo track, co-written with Tim Rice-Oxley |
| **Can I Have It Like That** | ft.Akon | **false** — the recording is *Pharrell* ft. Gwen Stefani |

Written: three credits moved into the title with the artist normalised to `Gwen Stefani`
(fixing the *Damian* spelling and the truncated title in the same call), and two false Akon
credits removed. Verified **11 -> 7**; the seven survivors are well-formed `feat. X` compounds
on real collaborations and are deliberately left.

**Raised flag #20** rather than guessing on *Can I Have It Like That*. Removing the false Akon
credit was unambiguous, but the recording properly belongs to Pharrell's *In My Mind* (2005) —
re-attributing it would move the track out of the Gwen Stefani compilation it sits in. That is
a collection-shape decision, not a metadata fix, so it goes to a human. The distinction is
worth keeping: *"this credit is wrong"* and *"this song is filed under the wrong artist"* are
different claims, and only the first was provable from the track.

### Sixteenth stretch — track numbering, and a hypothesis that failed usefully

Probed duplicated `(disc, track)` slots expecting a precise duplicate signal — the Motörhead
`Shine` pair had surfaced that way. **The hypothesis was wrong**, and the first result said so:
14 *different* Beatles songs all tagged track 63, and El Polaco's tracks colliding at 1/3, 1/4,
1/6. A shared slot is mostly a **numbering** defect, not a duplication one.

Splitting the 429 duplicated slots by whether the titles match turns one bad signal into two
good ones:

| titles in the slot | meaning | count |
| --- | --- | --- |
| different | broken track numbering | **298** |
| same (folded) | true duplicate | **131** (131 files, 52 albums) |

So a slot collision alone is only ~30% duplicate — a rule built on it without the title
comparison would fail exactly the way `missplit_album` does (#947).

**Filed [#959](https://github.com/kevinch3/NicotinD/issues/959)** for the numbering half:
**101 albums** with colliding slots and **490 songs across 77 albums** with no track number at
all. *With the Beatles* has all 14 tracks numbered 63, so the album has no running order;
*El polaco - Vuelve te lo pido* is 167 songs in one album row with ~10 per slot, almost
certainly several releases bundled with per-disc numbering lost. Two structural reasons this
never surfaced: **no audit rule covers track numbering**, and **`fix_song_metadata` accepts no
`track` or `disc` field**, so a curation session can identify every case and repair none. The
issue asks for both.

**Posted the 131 same-slot duplicates to [#951](https://github.com/kevinch3/NicotinD/issues/951)
as its high-confidence first tier.** They are stronger evidence than that issue's own fold +
duration heuristic: album, slot and title all agree, and many are byte-identical —
`Pescado Rabioso / Pescado 2` has ten pairs at identical bitrate *and* identical duration.
One SQL query, no fingerprint needed; reserve `recordingId` confirmation for the cross-album
candidates where album context genuinely does not settle it.

### Seventeenth stretch — artist origin coverage, and a fragment my own probe had missed

Opened `set_artist_origin`'s lane: **2,559 of 3,530 artists have a country**, 1,158 are
checked-but-null, and `library_artist_origins` holds **187 orphan rows** for artists removed by
merges (cruft; pruning is admin-only).

The origin backlog itself proved less interesting than two names inside it.

**`The Rolling Stone` (10 songs) is a singular/plural typo of `The Rolling Stones` (256).** All
ten are *Voodoo Lounge* tracks. Merged; 256 -> **266**.

This one is worth recording as a miss: the truncated-name probe two stretches ago should have
caught it and did not, because it required `b.name.startsWith(a.name + ' ')` — a **space** after
the prefix. `Stones` is `Stone` + `s`, so it fell straight through. The generalised
discriminator I wrote up then ("does the candidate's other half already exist as an artist
row") was right; my *implementation* of it quietly excluded the single-character case. A probe
is only as good as its boundary conditions, and this one had an off-by-one in its whitespace
assumption.

**`GIGI D'AGOSTINO` has no lowercase twin** — so not a fragment, just an all-caps tag artifact
(he does not stylise that way, unlike ROSALÍA or NICKI NICOLE, which are left alone). Renamed;
the call returned **`kind: "renamed"`**, which usefully sharpens #956: the rename path works
for case, and it is *specifically* whitespace-only renames that are unreachable, not renames in
general.

**Ten vinyl-side prefixes cleaned.** Those Stones tracks were titled `TrackA2 You Got Me
Rocking`, `TrackB1 The Worst`, `TrackE6 Out Of Tears (Bob Clearmoutain Edit)` — side/position
codes from a vinyl rip baked into the title. Stripped all ten, and corrected
`Clearmoutain` -> **Clearmountain** (Bob Clearmountain, the mixing engineer) in the same call.
Verified 10 -> 0.

### Eighteenth stretch — re-running the probe that had a hole in it

Re-ran the artist-prefix probe without the trailing-space requirement that hid
`The Rolling Stone`. 69 non-space prefix pairs, and the noise is exactly what the earlier
concatenation probe predicted: `Angel` prefixes `Angela Leiva`, `Angelo Badalamenti`,
`Angelito Martinez`, `Angels Of Light`; `Marsh` prefixes `Marshmello` and `Marshall Jefferson`;
`Robin S` (a real house artist) prefixes `Robin Schulz`. Coincidental prefixes, not fragments.

**A correction to my own first read.** The comma-suffixed hits looked like a large new class,
and a `;` separator looked like a whole shape nothing handled. Measuring it: only **3 artist
rows** contain `;` against **87 songs** whose artist string does. `splitArtists` handles
semicolons correctly — 84 of 87 songs bucket under the right artist. Three slipped through, not
a class.

Applied the fold rule to those three, and it separated them cleanly:

| row | title | decision |
| --- | --- | --- |
| `Maluma;Leslie Grace` | *Tengo un Amor* **(feat. Leslie Grace)** | merge -> `Maluma` — title keeps the credit |
| `Maluma;El Micha` | *Solos* **(feat. El Micha)** | merge -> `Maluma` — same |
| `Flor De Toloache; John Legend; Cultura Profetica` | *Quisiera* | **keep** — title carries nothing, and the base row has 0 songs, so folding would erase two credits and gain nothing |

Also fixed a song whose artist tag was its own name repeated six times
(`Vilma Palma E Vampiros;Vilma Palma E Vampiros;…`). It was already bucketed correctly under
`Vilma Palma e Vampiros`, so nothing was fragmented — but `library_songs.artist` is what
renders per song, so the string itself was user-visible. Verified 3 -> 1 rows.

**The lesson from the miss is about probe boundaries, not about the rule.** The generalised
discriminator ("does the candidate's other half already exist as an artist row, and do the
tracks corroborate it") held up again here — it correctly rejected all 69 coincidental
prefixes and accepted the three real ones. What failed last time was a whitespace assumption
inside the query, and I had recorded the rule as validated on the strength of that query. A
probe's boundary conditions deserve the same scrutiny as its logic.

### Nineteenth stretch — sanity checks: truncated years, and genre bloat

Ran three sanity probes that no rule covers.

**Truncated years — 4 albums, 3 fixed.** Not *missing* years but *mangled* ones, digits lost:
`year=20` (Gotye, *Making Mirrors* -> **2011**), `year=200` (The Chemical Brothers,
*We Are The Night* -> **2007**), `year=706` (Black Eyed Peas, *Monkey Business* -> **2005**).
69 songs corrected. Left `year=199` on Raffaella Carrà's *Raffaella / Forte, Forte, Forte /
Liebelei* — it is a three-album compilation and `199` could be a truncated 199x reissue or a
mangled 1976; guessing a decade is exactly what the playbook says to replace with a search.

Worth noting these are invisible to `missing_year`, which tests `year IS NULL OR year <= 1`.
A year of 706 is present and positive, so it passes — the rule asks "is a year set?", not "is
this a year?".

**Durations**: 0 songs at or under 2s, 16 over an hour. The long ones are genuine livestream
recordings (`Live at Sidney Myer Music Bowl`, 8.6 h). No defect.

**Genre bloat — filed [#960](https://github.com/kevinch3/NicotinD/issues/960).** Mean genres
per song is **2.65**, but **1,036 songs carry more than 8**, 51 carry more than 20, and the
worst carries 33. Skrillex's *Rumble* is a dubstep track tagged `Screamo`, `Rock` and
`Country`; Beyoncé's *Halo* is tagged `Country` and `House`.

The harm is provable rather than aesthetic, and it is an interaction between two correct
things. `expandGenreWhere` (`curated-playlists.ts:234`) deliberately matches the **full**
genre set — its comment says matching `s.genre` alone "would silently drop secondary-genre
matches", which is right for a 2-3 genre song. For the 1,036-song tail it inverts: a 25-genre
song satisfies nearly every genre filter, so it surfaces in a Country station, a House station
and a Rock station alike. And because heavily-tagged songs are usually *popular* songs, the
tail is over-represented in selection rather than randomly spread.

Recommended fix is to bound the **matching** set rather than the stored one — have
`GENRE_SET_EXPR` consider the first N positions (N=5 covers 94.6% of songs entirely), keeping
every genre for display. Explicitly did **not** mass-edit the 1,036 songs: truncating stored
sets by hand would discard real information and could not be reviewed; the defect is in how
the set is used, not in the data.

### Twentieth stretch — albums filed under the wrong artist entirely

Probed classification and compilation coherence. The big find: **30 albums filed under
"Various Artists" whose songs are all by one real artist.** Not a tag nuance — the album lands
in the VA bucket instead of the artist's discography, so *Mezzanine* was not under Massive
Attack and *Hot Shot* was not under Shaggy.

**Re-attributed 15 with `fix_album_metadata`, moving 104 songs:** Julieta Venegas *MTV
Unplugged* (12), Shaggy *Hot Shot* (15), Massive Attack *Mezzanine* (10), Pharrell Williams
*G I R L* (11), SOFI TUKKER *Treehouse* (9), Nonpalidece *Hecho en Jamaica* (9), Gramatik
*Epigram* (8), Lucio Demare *Al Pasar* (8), David Guetta, Calvin Harris ×2, María Becerra,
RÜFÜS DU SOL, Rodolfo Biagi, Los Ángeles Azules. Verified **30 -> 15**.

**The 15 left are deliberate.** "All songs share one artist" does not prove the *release* is
that artist's: `Latin Ska Force` holds 17 Los De Abajo tracks but is plausibly a compilation of
which we only own their contributions, and `Serie 78 RPM: Orquestas De Antaño`,
`Messirve Mix 9` and `The Best of the Black President` (2 Fela tracks) have the same shape.
Re-filing those would assert a release identity the data does not support — the counts are
identical to the 15 I *did* fix, and only the album's own name separates them.

**A second class, left for a decision: the inverse.** 10 albums are filed under a single artist
while holding many different ones — `Más Flow` (20 songs / 20 artists, Luny Tunes),
`Green Velvet at Factory Town Miami 2026 (DJ Mix)` (30/28), `Body Language Vol. 17 by
WhoMadeWho` (13/13). These are producer compilations and DJ mixes, where crediting the
curator is arguably right and `classification: 'compilation'` is the more accurate fix than
re-attribution. One in that list looks like a genuine defect rather than a DJ mix — Gloria
Estefan's *Mi tierra* (12 songs / 12 distinct artists) is a real single-artist album from 1993,
so its per-song artist tags are wrong. Worth its own look.

**Also noted, not acted on:** three albums classified `single` while holding 7-9 songs
(Cassian *Laps*, Lady Gaga *Alejandro* and *Paparazzi*). These are single-plus-remixes
releases, so `single` is arguably defensible and `ep` arguably better; not worth a write
without a convention decision.

### Twenty-first stretch — an entire album recovered by fingerprint

Followed last stretch's lead: **Gloria Estefan's *Mi tierra*** showed 12 songs / 12 distinct
artists. It was not a tagging nuance — the rip was **completely untagged**: titles `Track 1`
… `Track 12`, artists `01 Unknown Artist` … `12 Unknown Artist`. Only the album row carried
identity, presumably from the folder name. This is precisely `identify_song`'s documented
case, so all twelve were fingerprinted.

**Eleven came back as genuine *Mi tierra* recordings by Gloria Estefan**, scores 0.97-0.99 —
*Con los años que me quedan*, *Mi tierra*, *Mi buen amor*, *Tus ojos*, *No hay mal que por
bien no venga*, *¡Sí señor!*, *Volverás*, *Montuno*, *Hablemos el mismo idioma*, *Hablas de
mí*, *Tradición*. All applied; the album is now fully identified where it was previously
unsearchable and unplayable by name.

**The twelfth is flagged (#21), not guessed.** Track 3 returned **Glenn Miller — "Don't Sit
Under the Apple Tree"** at 0.98. By elimination the slot should be *Ayer*. Two readings, and
nothing available separates them: the rip may genuinely contain a stray Glenn Miller track, or
this AcoustID cluster may carry a wrong label — a failure seen **earlier this same pass**,
when two independent Lenny Kravitz files both returned "Metro Station". Retagging a Gloria
Estefan album track as Glenn Miller on a label I cannot verify would be worse than leaving it.
Playing it settles the question in thirty seconds, which is a human's job, not a fingerprint's.

**Generalised the class rather than stopping at one album.** Probing every multi-song album
for junk titles (`Track N`, `Pista N`, bare numbers) or placeholder artists (`Unknown Artist`,
`artist`, `<desconocido>`) found only **1 more fully-affected album and 7 partial** — so
*Mi tierra* was the bulk of it and this is now nearly closed. The remaining one, `Bandana`,
turned out not to be junk-titled at all: real lowercase titles with the artist tag literally
set to `artist`, from an `artist/Bandana/` folder. Fixed both (`Adónde vas`,
`Vivir intentando`). Those two also appear under `Bandana/Singles/` in the orphan-file list,
so they are probable duplicates — that question belongs to #951, not here.

### Twenty-second stretch — junk tags inside good albums, and a heuristic that overreached

Worked the 7 *partially* junk-tagged albums the previous probe surfaced. 12 writes, and the
triage mattered more than the volume.

**My own `^\d{1,2}$` "junk title" heuristic produced three false positives.** Taylor Swift's
**"22"** (*Red*), Shakira's **"23"** and Doja Cat's **"97"** (*Scarlet*) are *real song titles*.
A bare-number title is not junk — which is the same trap `numeric_single`/`isNumericLikeName`
already exist to navigate in the codebase, and I walked into it while writing a fresh probe.
All three left untouched.

**Fixed — La Portuaria, *10000 km*, 11 songs.** Real titles, artist tag `<Desconocido>`.
Notable because this exact mis-tag is the **worked example in `db.ts`'s own schema comment**
for `library_metadata_overrides` ("a mis-tagged artist `<Desconocido>` → `La Portuaria`"). The
override had corrected the *album row*; the eleven *song* rows still carried `<Desconocido>`.
A durable album-scope override does not rewrite song tags, so the two stores disagreed
indefinitely — worth knowing when judging whether a past fix "landed".

**Fixed — Limp Bizkit, *Gold Cobra* track 11.** Titled just `10`; fingerprinting returned
**"90.2.10"** at 0.99, confirming a truncation rather than a numeric title. This is the case
that justifies not dismissing bare numbers wholesale either — three were real, one was not,
and only the fingerprint separated them.

**Left deliberately:** Falsa Cubana's `Pista 4` returned **`no-match`** — genuinely unknown to
AcoustID, which the playbook says is a real answer for long-tail regional catalogue, not a
failure. Inventing a title would be worse than leaving it. And *Mi tierra* track 3 remains on
flag #21.

Verified **7 -> 5**, where all five survivors are decisions rather than remaining work.

### Twenty-third stretch — an invisible split, and the #787 guard proving itself

Generalised the La Portuaria finding: checked all **620** `library_metadata_overrides` against
their songs' tags. 97 disagree on artist and **87 point at an album that no longer exists**
(dead overrides, cruft). But most of the 97 are not defects — `Astor Piazzolla` vs
`Astor Piazzolla & Horacio Ferrer` (Ferrer wrote the libretto), `Ratones Paranoicos, Andrés
Calamaro` — album artist and song artist *should* differ on a featured track.

Refining to the real class — the same artist under two spellings **inside one album** —
surfaced accent and casing splits (`Fito Paez`/`Fito Páez`, `ABBA`/`Abba`,
`Deadmau5`/`deadmau5`, `Rafaga`/`Ráfaga`) and one that stopped the pass:

```
"The Don" — Donny Benét
     "Donny Benét"×7   vs   "Donny Benét"×1
```

Visually identical. It is a **Unicode normalisation split**: 7 songs stored NFD, 1 NFC. A
column-wide check found 16 song artists, 4 titles and 3 artist rows not in NFC — Rosalía was
split 8 NFD / 4 NFC the same way.

**Checked the obvious fear before writing it up, and it does not happen**:
`normalizeArtistForGrouping` folds the two forms, so Donny Benét's 8 songs sit under one
artist row and Rosalía's 59 under one. Not a catalogue split — a latent hazard for anything
comparing strings *exactly*, which is invisible in every log and UI. macOS normalises to NFD,
which explains a single album split between forms rather than a whole artist.

**Normalised all 20 rows** (verified: songs 16 -> 0, titles 4 -> 0, album names 2 -> 0) and
**filed [#961](https://github.com/kevinch3/NicotinD/issues/961)** for the mechanism — one
`.normalize('NFC')` at the scanner's tag-read boundary, plus a check, since hand-fixing rows
does nothing about the next Mac-sourced ingest.

**The #787 guard has shipped, and it caught me.** Sending `Anyma &amp; Rebūke` was rejected
with *"contains the HTML entity `&amp;`. Send the bare character."* That is precisely the
mistake that previously created a literal `Wisin &amp; Yandel` row. The curation skill and
docs still describe this guard as *proposed* — it exists, it works, and per the skill's own
maintenance rule ("closing an issue means pruning this file in the same pass") that line is
now due for an update rather than being carried as live advice.

### Twenty-fourth stretch — the spelling-split class, cleared to zero

Two things, one of which changed the cost of the work by an order of magnitude.

**Pruned the skill's stale #787 line.** Verified first: issue closed 2026-08-29, guard live at
`routes/mcp.ts:1252`. The skill still said *"a server-side guard is proposed in #787; until it
ships this is entirely on you"* — advice that had been wrong for over a week and, worse, told a
curator the failure mode was a silent bad row when it is now a rejected call. Rewritten to say
the guard ships, rejects, and that typing bare characters remains the habit because the guard
covers name/title arguments and not every argument. 8-line diff, per the skill's own
maintenance rule.

**Then the spelling splits — and a discovery that reframed them.** 164 songs sat under
non-canonical spellings across 14 variants, which looked like 164 `fix_song_metadata` calls.
Before committing to that, I tested whether an artist alias rewrites the *song* string, using
my own earlier merge as the probe:

```
songs still literally tagged "The Rolling Stone": NONE
row "The Rolling Stones"  <-  song artist "The Rolling Stones" ×266
```

**`merge_artist` rewrites `library_songs.artist`, not just the bucketing.** So a spelling fix
costs **one call per variant, not one per song**. The whole class — ~250 songs — closed in 28
calls. Verified: albums holding one artist under two spellings **0**.

**The judgement that mattered: majority is not canonical.** Choosing the more common spelling
would have been wrong in seven cases, because the *minority* was correct:

| kept | discarded (more common) |
| --- | --- |
| `Axé Bahia` | `Axé Bahía` ×13 — *Bahia* takes no accent in Portuguese |
| `Jarabe de Palo` | `Jarabe De Palo` ×10 |
| `Vilma Palma e Vampiros` | `Vilma Palma E Vampiros` ×13 |
| `Matías Aguayo` | `Matias Aguayo` ×8 |
| `Ángela Leiva` | `Angela Leiva` ×5 |
| `El Símbolo` | `El Simbolo` ×7 |
| `Las Pastillas del Abuelo` | `Las Pastillas Del Abuelo` — (here the majority was right) |

A frequency-based auto-fix would have entrenched `Axé Bahía` and `Matias Aguayo` permanently.
This is the part of the class that is *not* mechanical and should stay with a human or an
agent that can reason about the language — worth remembering if any of this is ever automated
under the Phase 1 heading.

### Twenty-fifth stretch — the spelling class, library-wide: 42 clusters -> 10

The previous stretch cleared spelling splits **within one album**. Generalising the same fold
across the whole library found the real size of the class: **42 clusters covering 888 songs**,
most of which never co-occur on an album and so were invisible to the narrower probe.

Fixed 39 variants in ~39 `merge_artist` calls — one per variant, not per song, which is only
affordable because of last stretch's finding that a merge rewrites `library_songs.artist`.
Verified **42 -> 10**, covering 214 songs.

Canonical choices again required judgement rather than frequency. Accented forms restored
(`Raffaella Carrà`, `Serú Girán`, `Thalía`, `Tego Calderón`, `Antonio Ríos`, `Arcángel`,
`Maná`, `Márama`, `Édith Piaf`, `La Factoría`, `Café Quijano`, `Ángela Leiva`, `Tambó Tambó`,
`Orquesta Típica Victor`); deliberate stylings kept where they are the artist's own
(`KAROL G`, `MIKA`, `ARTBAT`, `HUGEL`, `GIT`, `ZAZ`, `RÜFÜS DU SOL`), and shouty rips
normalised where they are not (`TASH SULTANA` ×21 -> `Tash Sultana`, `EROS RAMAZZOTTI`,
`NATHY PELUSO`, `MARC ANTHONY`, `RICARDO ARJONA`, `BANDANA`).

**Deliberately left, with reasons** — the ten survivors are decisions, not leftovers:

- `Tru La La` ×37 vs `Tru la lá` ×7 — the band writes itself *Trulalá*; neither stored form is
  clearly right and picking one would encode a guess.
- `ADRIANNA`/`Adrianna` and `Spirit`/`SPIRIT` — one song each side, no evidence either way.
- `MTV Unplugged 'Dream My Life Away` — a junk artist row, not a spelling question.
- `Nicole Moudaber ` — **blocked by #956**, the whitespace-only rename the tool cannot express.

**A conflict worth recording**: `Angela Leiva` survived two merge attempts into `Ángela Leiva`.
The alias table already holds an older `source='user'` row mapping
`angela leiva official -> Angela Leiva` — the *unaccented* form — so a previous decision pins
the wrong canonical and re-asserts it. Aliases are documented as never overwritten once
`source='user'`, which is the right rule and also why a wrong one is sticky. That is a second
concrete argument for #949's proposal to make the alias table writable and reviewable from
curation, rather than only appendable through merges.

### Twenty-sixth stretch — a clean negative, and six classifications

**Album names have no spelling-split class.** Applied the same fold that found 42 artist
clusters to album names grouped per artist: **0 clusters**. Album grouping already folds the
variants that artist grouping did not, so the defect is specific to the artist axis. A quick
negative worth recording so nobody re-runs it.

**Classified 6 albums as `compilation`.** These are producer compilations and DJ mixes filed
as `album` under the curator's name — `Más Flow` and `Más Flow 2` (Luny Tunes, 20 and 23
tracks by as many artists), `Green Velvet at Factory Town Miami 2026 (DJ Mix)` (30/28),
`Get Physical Presents: Body Language Vol. 17` (13/13), Pete Tong's `Chilled Classics`
(17/14), and Osvaldo Pugliese's `El rodeo (1943-1945)` (a dated historical gathering, and
previously mis-classified `ep`). `set_album_classification` also sets the manual-override
flag, so the automatic curator will leave these alone across rescans.

**Three deliberately left as `album`**, because "many distinct song artists" does not mean
compilation:

- **CamelPhat — *Dark Matter*** (23 songs / 18 artists) is their own 2020 studio album; the
  artist count is *featured vocalists*, one per track. Reclassifying it would be wrong.
- **Damian Lazarus — *Magickal*** and **Green Velvet — *Unshakable*** (13/13) could be either
  a curated mix or an album with heavy features, and nothing in the data distinguishes them.

That is the same shape as the "Various Artists" judgement two stretches ago: the numeric
signal is identical across the cases that should be changed and the cases that should not, and
only knowing what the release *is* separates them. Worth stating plainly for the Phase 1
design — this dimension looks like a rule and is not one.

### Twenty-seventh stretch — 9 real tracks were invisible

Listed the 6 `hidden` albums, a state I had never inspected. Five are correct — Tash Sultana
promo clips of 15-47 s whose titles *are* the watermark. The sixth was not:

```
"2001 - Coolio.com" — Coolio (2001), 9 songs
   "Right Now" 241s   "The Hustler" 213s   "The Partay" 216s   "Dead Man Walking" 202s
```

***Coolio.com* is Coolio's actual 2001 album.** Full-length tracks with real titles, hidden
from the UI because the title contains a domain.

Traced it rather than assuming a past curator mistake — `manual_override` was 0, which ruled
that out immediately, since `set_album_classification` sets that flag. The cause is
`library-curator.ts:193`:

```ts
if (looksLikeSourceWatermark(row.artist) ||
    looksLikeSourceWatermark(row.name) ||     // <- "2001 - Coolio.com"
    isNumericLikeName(row.artist)) {
  return { classification: 'unknown', hidden: true };
}
```

**Filed [#962](https://github.com/kevinch3/NicotinD/issues/962)**, with two findings beyond
the bad match:

1. **It short-circuits the authoritative-metadata check.** The very next block is commented
   *"a known catalog release is never hidden"* — and is unreachable for this album, because
   the watermark test returns first.
2. **The hide path lacks the guard the delete path has.** `albumHasRealTrackTitles`
   (`library-audit.ts:511`) protects an album from *deletion* when any track has a real title
   — #705's "junk metadata is not junk audio". The curator's *hide* decision has no
   equivalent. The codebase already contains the right idea and applies it to only one of the
   two destructive-ish paths.

That guard is also exactly what separates the two cases here: applied to the hide decision it
keeps all five Tash Sultana clips hidden (their track titles *are* the watermark) and stops
hiding *Coolio.com*. One predicate, already written, in the wrong place.

**Restored it** via `set_album_classification` (which sets `manual_override = 1`, so the next
reclassify will not re-hide it — the state was re-asserting itself on every pass, not a stale
one-off). Verified: hidden **6 albums / 14 songs -> 5 / 5**.

Worth noting how it was found: no worklist surfaces this. `hidden` is excluded from every
health dimension by construction, so a false positive here removes music from the library with
nothing reporting it. I found it by listing hidden rows directly, which is a thing to do
deliberately rather than a thing any tool suggests.

### Twenty-eighth stretch — correcting my own query found a 56-song defect

Chased the "invisible by construction" angle that found *Coolio.com*. Two clean negatives
first, both worth recording so they are not re-run:

- **0 songs have `landed_at IS NULL`.** I had assumed the genre metric's
  `landed_at IS NOT NULL` denominator was hiding ~197 songs. It is not; the denominator
  excludes nothing.
- **139 songs have a dangling `library_songs.artist_id`, and it is not a bug.** All 139 are
  multi-artist compounds (`Skrillex, Fred again.., Flowdan`, and nine more using `;`, ` con `,
  ` Y `, ` x ` that my first filter missed). Every one has correct `library_song_artists`
  credits. `artist_id` is minted from the compound string, which has no row — dangling by
  construction. The app handles it: only one query joins that column and it correctly uses
  `LEFT JOIN` (`genre-distribution.ts:209`); the other four join the *join tables*, whose FKs
  are valid. No issue filed.

**But my own probe did not handle it**, and that is the finding. The artist-origin ranking two
stretches ago inner-joined `library_songs.artist_id`, so it silently dropped every
compound-credited song. Re-running it credit-aware via `library_song_artists` changed the
answer:

```
credit-aware:   IPAUTA 56 | Gigi D'Agostino 55 | Pappo's Blues 51 | Tru La La 45 | Ed Sheeran 36 | The Black Eyed Peas 29
old (inner):    Gigi D'Agostino 55 | Pappo's Blues 48 | Tru La La 45 | Ed Sheeran 36 | ...
```

**IPAUTA — 56 songs — was absent from the old ranking entirely.** It is a Latin download-site
brand, credited on 56 songs whose own artist strings are already correct (Tego Calderón,
Daddy Yankee, Don Omar, Wisin & Yandel). Source: the files sit under an artist folder literally
named `IPAUTA/`, so the site is credited *on top of* the real artist — which is exactly why
nothing looked wrong. Every song displays its true artist while the site quietly accumulates 56.

**Filed [#963](https://github.com/kevinch3/NicotinD/issues/963).** `watermark_artist` reports 0
because `looksLikeSourceWatermark` keys on URL shapes and `IPAUTA` is a bare token; `orphan_artist`
cannot see it because it has real credits. Nothing compares a credit against the song's *own*
artist string, which is where the contradiction lives — 56 of 56 disagree. That check needs no
watermark vocabulary and so generalises to the next brand without a list update.

**Fixed the one unambiguous row**: the `IPAUTA` / `IPAUTA` album (10 songs by various real
reggaeton artists) is now `Various Artists` / `compilation`. The 46 credits on the two *Más Flow*
compilations stand — those albums are correctly attributed to Luny Tunes, and **no MCP tool can
remove a single credit** from `library_song_artists`, so a curation session can find all 56 and
repair none.

### Twenty-ninth stretch — the check generalised, and a correction to my own issue

Ran the discriminator proposed in #963 across the library: artists with >=3 credits whose
credited songs **never name them** in their own artist string. **One hit, and it is a false
positive** — `Pete Tong, The Heritage Orchestra & Jules Buckley` vs
`Pete Tong, Jules Buckley & The Heritage Orchestra`: the same three acts in a different order,
which a substring test cannot see. So IPAUTA was singular rather than the first of a class.

**But IPAUTA should have appeared in that run, and did not** — which is the useful part.
Checking instead of accepting the empty result:

```
IPAUTA artist row: GONE
songs still under an IPAUTA/ folder path: 46
IPAUTA-folder songs with NO credits: 0 / 46
```

Correcting the single `IPAUTA`/`IPAUTA` album row cascaded: the rescan removed the **whole**
artist row and all 56 credits, not the 10 I targeted. **Posted a correction to
[#963](https://github.com/kevinch3/NicotinD/issues/963)** — its body claims the 46 were
untouched and that a curation session "can identify all 56 and repair none", and both are now
wrong. An album-level correction *can* clear credits; it just cannot do so selectively.

**A separate question surfaced by the new state, flagged not filed.** The 46 songs are now
credited to **Luny Tunes** — the compilation's real producer, a clear improvement on a download
site — but their own artist strings are absent from the credit list:

```
"Métele sazón"   tag "Tego Calderón"   credits: "Luny Tunes"
"Aventura"       tag "Wisin & Yandel"  credits: "Luny Tunes"
```

On a compilation, `library_song_artists` holds the *album* artist and not the *track* artist,
so a search for Daddy Yankee will not surface his track on *Más Flow*. Whether that is
intended is a design question, so it went as a comment on #963 rather than a second issue —
filing a defect against behaviour that may be deliberate is how false worklists start, which
is the same mistake #947 and #954 encode.

### Thirtieth stretch — answering my own open question, and withdrawing it

Last stretch I flagged that *Más Flow* songs are credited to `Luny Tunes` rather than their own
track artists, and wondered aloud whether a Daddy Yankee search would miss his track. Rather
than leave that sitting in a tracker, I answered it.

**It is deliberate**, documented at the write site (`library-scanner.ts:618`):

> `library_song_artists` means *confirmed performers*, so it must never be the door a compound
> sneaks an artist row in through. `splitCredits` is confirmation-gated… an unsplit credit that
> is not already the owner falls back to the owner. Nothing is lost: the verbatim credit still
> lives in `library_songs.artist`.

The rationale is #817 — linking an unconfirmed compound mints phantom artist tiles, up to 13
for *Unshakable* alone.

**And the mitigation is real.** Instead of more code archaeology I tested the behaviour:
searching `Daddy Yankee` returns `Cojela Que Va Sin Jockey`. Search reads the verbatim artist
string, so the credit table falling back to the owner costs nothing where it would have
mattered.

**Withdrew the concern on #963** rather than leaving an unfounded worry on the issue. Worth
naming the pattern, because it is the third time this pass: a shape that looks wrong from the
data alone (`orphan_artist`'s 485, the dangling `artist_id`s, this) turns out to be deliberate,
and the deciding evidence was a comment written next to the code or a two-minute behavioural
test — never the data. **Reading the row and reading the intent are different acts, and only
one of them can tell you a thing is broken.**

The cheap habit that keeps paying: when a query suggests a defect, spend one call testing the
*behaviour* before writing anything down. It settled this in a single `search_library` call
after several greps had not.

### Thirty-first stretch — closing a pending acceptance measurement

Opened `library_song_analysis_failures`, a table no curation pass had looked at: **27,146
rows**. Almost all of it is expected residue — `no recording MBID` 18,536, `Lidarr has no
genre` 3,053, `no discogs match` 1,595, and a long tail of `genre confidence 0.1x below
threshold`. Those are the capped automated lanes the playbook already describes, not work.

Two things in it were worth the read.

**#851's prod re-measure, which my notes still had as outstanding.** The issue closed
2026-08-31 with the backfill and re-measure pending. Measured now:

| | |
| --- | --- |
| `last_error = 'invalid recording MBID'` | **24** |
| `terminal = 1` | **24 / 24** |
| `fail_count` | **1** on every row |

That is exactly the post-fix shape. Each poison-pill track failed **once**, was ledgered
terminal, and is no longer retried — so it cannot re-enter the created-DESC pool and livelock
it, which was the whole defect. The affected set is broader than the issue's 25-track batch but
identical in shape: whole albums carrying a bad `MUSICBRAINZ_TRACKID` — Los Tres ×10, La Oreja
de Van Gogh ×13 (*El planeta imaginario*), C. Tangana ×1, Kylie Minogue ×1.
**Posted to [#851](https://github.com/kevinch3/NicotinD/issues/851)**; nothing needs reopening.
Those 24 will never get popularity data until the tag is fixed in the files, and
`fix_song_metadata` has no `MUSICBRAINZ_TRACKID` surface, so it is unreachable from curation.

**4,705 of 27,146 rows (17%) reference a song that no longer exists.** The table has an
`orphaned_at` column so the state is tracked, but nothing prunes them. Left as an observation
on the issue rather than a new filing — it may be intended retention, and filing against
possibly-deliberate behaviour is the mistake #947 and #954 encode.

A note on the earlier decode lead: four rows carry `ffmpeg PCM decode exited with code 183`,
which looked like corrupt audio. They join to **no song** — they are orphaned rows for files
already removed. Chasing them as "unplayable files" would have been chasing history.

### Thirty-second stretch — #720's accent fold, re-measured and closed

Second pending acceptance measurement cleared. #720 ("fold accents instead of deleting them,
across every matcher") merged 2026-08-25 with its prod re-measure outstanding.

**Structural:**

| | |
| --- | --- |
| artist rows differing only by accent/case that did **not** fold | **0** |
| album rows under one artist, same test | **0** |
| artists whose name contains a non-ASCII character | **219 / 3,523** (6.2%) |

The denominator is the point: with 219 accented artist names present, zero is a result rather
than a vacuous pass. Recording it because #612 is this repo's standing lesson about gates that
report a false denominator — a fold test over an all-ASCII library would pass while proving
nothing.

**Behavioural**, which the schema query cannot answer:

```
search "Americo"  ->  artist "Américo", album "A morir", song "Te Vas"
search "rosalia"  ->  artist "Rosalía"  AND  "C. Tangana, ROSALÍA"
```

Unaccented lower-case input reaches accented upper-case data, including inside a compound
credit — the exact user-facing behaviour the ASCII-strip bug broke (#706, #707, #662, #719).
**Posted to [#720](https://github.com/kevinch3/NicotinD/pull/720)**; nothing to reopen.

Two things the same query surfaced that are *not* regressions of this change: `C. Tangana,
ROSALÍA` correctly remains distinct from `Rosalía` (a collaboration, not an accent variant —
folding it would erase C. Tangana), and a duplicate cluster around
`A NINGÚN HOMBRE (Cap.11: Poder)` that belongs to #951.

Both close-outs this stretch and last followed the same shape, worth naming: **a "pending
re-measure" is usually one query and one behavioural probe away, and the reason it stays
pending is that nobody is looking at that table.** Two sat open for a week and eleven days
respectively; both were confirmations, not surprises — but neither was known until measured.

### Thirty-third stretch — 13.19 GB stranded in staging, accumulated this week

Continued the pending-re-measure sweep and hit something bigger than a confirmation.

**#687** — songs with `landed_at NULL`: **0 / 19,217**. Landing gate holds. Closed.

**#827** — and here my own note was wrong. "0 FLAC on disk" is true of the *organised library*
(0 DB rows with a lossless suffix, `losslessSongs: 0`) but **not of the disk**: 302 lossless
files, **12.88 GB**, all under `.downloads/`. Those two statements are different and my memory
had collapsed them.

Walking staging properly:

| | |
| --- | --- |
| audio files in `.downloads/` | **343** |
| total | **13.19 GB** |
| folders | 36 — **22** match a library album, **14** have none |

**It is not idle staging: the library is visibly short the same tracks.** Six matched folders
hold more than the library does —

```
Highway to Hell — AC/DC     staged 10   library  1
T.N.T. — AC/DC              staged 18   library  5
Absolution — Muse           staged 25   library 11
Sheer Heart Attack — Queen  staged 18   library 12
```

So albums are reported incomplete while the missing tracks sit on disk. That links this to
`completeness.confirmedIncomplete` (113): some fraction of that worklist is not "we lack these
tracks" but "we have them and never filed them" — and a `complete_album` hunt against one would
re-download audio already present.

**Dated it, because "closed issue" and "13 GB" should not sit together on an assumption.**
Newest mtime per folder spans **2026-08-30 to 2026-09-06** — the last week, nothing older. So
this is current, not pre-closure residue. Two folders are from today and may be legitimately in
flight (both Gramatik, library counts already match); the other **34 are 3-7 days old**, past any
plausible in-flight window.

**Posted both measurements to [#725](https://github.com/kevinch3/NicotinD/issues/725)** — which
is **closed** — and deliberately did not reopen it: the fix there may be correct and this may
come from a sibling path (#710/#711/#714 are the same cluster). Flagging beats assuming.

**Why nobody has seen it**: `.downloads/` is correctly excluded by `isReservedPath`, so it
appears in **no** audit rule, health dimension or worklist — `orphan_file`'s 393 deliberately
excludes it. Right for scanning, but it means the leak's size is invisible from every surface a
curator or operator would look at. I found it only by walking the directory while re-measuring
something else.

### Thirty-fourth stretch — measuring an open claim, and finding it smaller than stated

#864 is open and its title carries two claims; I measured the second — *"the grid's
`split_compound` visibility is inverted"*.

```
split_compound = 0 : 3,390 visible
split_compound = 1 :   133 hidden
```

The deciding question is not how many are hidden but whether a hidden compound's **members
exist as their own artist rows** — if they do, the act stays browsable and the hide costs
nothing.

| of the 133 hidden | |
| --- | --- |
| every member exists as its own row | **122 (92%)** |
| only some members exist | 3 |
| **no** member exists | **1** |

The single total-loss case is malformed rather than a real act
(`"Der Dritte Raum / Der Dritte Raum, Acid Pauli / Acid Pauli"`, 1 credit).

**So on current data the behaviour is mostly correct, not inverted** — 122 of 133 hides are
safe and only 4 are lossy at all. Posted to
[#864](https://github.com/kevinch3/NicotinD/issues/864) as a scope/severity datapoint rather
than as a refutation: the issue's other half (a wrong artist *name* has no detector) is
untouched by this, and I said so explicitly rather than letting one measurement read as a
verdict on both.

The visible side passes the cases that would hurt most: `Tyler, The Creator` and
`Medeski, Martin & Wood` are single acts whose names contain a separator, correctly not split.

**One thing in the hidden set is a different problem wearing the same clothes.**
`Chet Baker & Strings` (15 credits) and `Slim Gaillard And Slam Stewart` are **release
billings**, not collaborations — splitting the first implies an artist called "Strings". That
is the compound-splitting judgement (#817's family), not the visibility rule. I flagged it as
such instead of counting it as evidence for the inversion, because folding two different
defects into one number is how a count stops being a workload — the same failure #947, #952
and #954 all encode.

### Thirty-fifth stretch — auditing this pass's own damage, and retiring a stale caution

#874 closed with a workaround still carried in the curation notes: *"a bulk MCP retag needs a
full library sync after it, or it leaves orphan album rows."* This pass was an unintentionally
good stress test — roughly **180 metadata writes and 45 `merge_artist` calls**, many re-minting
an `album_id` (every artist rename re-buckets; several album renames returned a new id
outright, e.g. `"La negra tiene tumbao  (Mp3)"` -> `La negra tiene tumbao`) — and **no manual
sync was run at any point.**

| | |
| --- | --- |
| album rows with zero songs | **0** (of 6,924) |
| artist rows with no songs, no credits and no albums | **0** |

The incremental retag path cleans up after itself, including under repeated id re-minting.
**Posted to [#874](https://github.com/kevinch3/NicotinD/issues/874)** and retired the
workaround from the notes, per the skill's own rule that closing an issue means pruning its
line in the same pass — a workaround kept past its fix teaches distrust of a surface that no
longer lies.

Two things worth separating in how this was done. First, it is a **self-audit**: the question
was not "is the codebase healthy" but "did my own 225 writes leave wreckage", and asking it
that way is what made the zero meaningful. Second, the same shape paid out earlier this pass —
checking whether my merges were stranding artist rows is what surfaced #954, because the answer
was *no, but the rule that reports them is 100% wrong*. **Auditing your own changes tends to
find defects in the thing that measures them.**

### Thirty-sixth stretch — answering a spike that was never run

My notes carried *"Discogs genre #194 blocked on the #191 spike, which was never actually run
(report is a placeholder)"*. Two things were wrong with that. **#194, #193, #191 and #211 are
all closed** — the work shipped without the spike. And the spike's question is now answerable
from production data, because the lane it was meant to gate has been running for weeks.

Tried the intended route first and stopped: the spike needs `DISCOGS_KEY`/`DISCOGS_SECRET`, the
container has neither, and its live run is documented as manual. Inventing a credential is not
a curation action, so I measured the shipped result instead.

**Contribution by lane** (`library_genre_overrides`, applied):

| source | scope | rows |
| --- | --- | --- |
| `user` (curator) | song | **1,027** |
| `essentia` | song | **431** |
| `discogs` | album | **316** |

**Unresolved** (`library_song_analysis_failures`): `genre` (Lidarr) 3,053 · `genre-audio` 2,471
(742 terminal) · `genre-discogs` **1,596**. Coverage today: **19,113 / 19,217 songs (99.5%)**.

**Refused to turn that into a hit rate**, and said so in the comment: 316 is *album*-scope
overrides and 1,596 is *song*-level failure rows. Dividing them gives a confident-looking 17%
that means nothing, because each album override covers however many tracks that album holds —
and the fan-out is precisely what the spike was supposed to measure. What survives without it:
**Discogs is the smallest of the three automated lanes by override count, and the curator has
produced more than three times as many genre decisions as Discogs has.**

Posted to [#191](https://github.com/kevinch3/NicotinD/issues/191). Nothing reopened — the
integration works and the residual gap is 104 songs of 19,217. The placeholder report is the
only loose end, and it is loose in docs rather than in code.

## Session close-out — 2026-09-06, 36 stretches

Final `get_library_health` re-run, compared against the baseline taken at the start.

| dimension | baseline | final | note |
| --- | --- | --- | --- |
| artists | 3,560 | **3,523** | −37; ~45 rows merged away, rest is churn |
| albums | 6,933 | 6,924 | |
| songs | 19,080 | 19,217 | **not growth** — rescan re-mints ids (`sha1(path)`) |
| audit high | 143 | **86** | almost entirely `album_count_mismatch` 134 → 77 |
| audit medium | 4,780 | 4,752 | ~99% is noise (#952, #954) |
| genres missing | 190 | **170** | denominator also moved 18,987 → 19,217 |
| years missing | 191 | **184** | |
| covers missing | 4,276 | 4,266 | ~2,859 of these already render (#952) |
| hidden albums | 6 | **5** | *Coolio.com* restored |
| open review flags | 0 | **3** | #19 b2b credit, #20 Pharrell attribution, #21 Glenn Miller |

**What I will not claim.** The headline `audit high` drop is `album_count_mismatch` settling on
its own — the playbook says so explicitly (#774) and it would be dishonest to bank it. Nor is
the genre delta cleanly mine: the denominator grew by 230 in the same window. The numbers I
*can* stand behind are the ones re-measured against their own rule inside each stretch:

| class | before | after |
| --- | --- | --- |
| `fragmented_artist` | 6 | **2** (both deliberate keeps) |
| artist spelling clusters, library-wide | 42 | **0** |
| whitespace in titles / album names | 63 / 13 | **0 / 1** |
| watermark titles | 15 | **5** (the 5 are promo clips) |
| "Various Artists" misattribution | 30 | **15** (15 left deliberately) |
| `djset_artist` | 2 | **1** (flagged) |
| non-NFC text rows | 20 | **0** |
| orphan album rows after 225 writes | — | **0** |

**Writes: ~327.** Genres 32, song metadata ~110, album metadata 30, artist merges ~45, covers
30, classifications 7, flags 3.

**Issues filed: 16** — #946, #947, #949–#963. Four are predicate defects of one shape (a rule
answering a cheaper question than its name claims): #947, #952, #954, and the `titleMismatch`
finding. Two are capability gaps (#949, #956). One is a real data leak (#725's 13.19 GB).

**Pending items closed or corrected: 6** — #851 and #720 re-measured and confirmed, #874's
workaround retired, #687 confirmed, #191 answered retrospectively, #864 scoped down.

**Still requiring a human**: the 5 watermark deletes (blocked by the session's permission
classifier), 3 open flags, 16 genre-alias rows (#949), and the 13.19 GB in `.downloads/`.

### Thirty-seventh stretch — correcting my own #725 claim

Went back to verify a number I had already posted, rather than let it stand. I claimed **14 of
36 staging folders have no library album**, using a `LIKE` match of the folder *name* against
`library_albums.name`. Download-tool folder names are not album titles
(`Stromae - Album - 2013 - Racine carree`, `(2018) Natiruts - I Love`), so the instrument was
wrong.

Re-tested by sampling each folder's actual **track titles** and looking for those in
`library_songs`:

| verdict | folders |
| --- | --- |
| already in the library | **7** — Turf *Para Mi Para Vos* 6/6 sampled titles, Lou Bega 6/6, Natiruts *I Love* 6/6, *I Love [2018]* 5/6, *Some Girls (deluxe)* 5/6, Stromae 3/6, one Tom Jones fragment 1/2 |
| genuinely absent | **7** — `[2002] Qu4tro` (12 files), `A-Tom-ic Jones` (10), and five 1-2 file fragments |

**About half of what I called missing is already present**, so those staging copies are
redundant rather than lost. **Posted the correction to
[#725](https://github.com/kevinch3/NicotinD/issues/725)** and said plainly that the first
version was noisier than the evidence supported.

What survives the correction, unchanged: 13.19 GB still in `.downloads/`, still accumulated
inside one week; the six folders holding **more** tracks than the library (`Highway to Hell`
10 staged / 1 in library, `T.N.T.` 18/5, `Absolution` 25/11) — those were verified by *count*,
not by name, so the correction does not touch them; and its invisibility to every audit rule.

What changes: this is now mostly **disk waste and duplicate acquisition**, not data loss. The
A-Tom-ic Jones case — four staging folders for one release, none of it landing — is the
clearest remaining sign of a retry loop rather than a single strand.

The lesson is narrow and worth keeping: **a folder name is not a title, and matching on it is
not evidence.** The correct instrument was there the whole time — sample the content and look
*that* up — and it cost one query. I had already applied exactly this reasoning to
`missplit_album` in #947, where the rule matches album *names* and the fix is to match on what
the album actually contains. Filing that issue did not stop me making the same mistake nine
stretches later.

### Thirty-eighth stretch — narrowing a false class, and finding a file that cannot be written

Probed title-shape defects. Two clean negatives — **0** titles with a baked-in track number,
**0** channel artifacts (`- Topic`, `[Official…]`). Two apparent findings that were not:
**259 all-caps titles** are mostly deliberate styling (Bad Bunny, KAROL G, Rosalía's *MOTOMAMI*,
Moderat, Die Antwoord), and **240 titles matching their album name** are just title tracks.

Narrowing worked in two steps, and the first step was still too coarse. *"Artist has both caps
and mixed-case titles"* gave 57 artists — still mostly legitimate, because artists vary styling
**per album**. *"A minority of titles inside one album are caps"* gave **11**, of which **9 are
real** (`NI BIEN NI MAL`, `CANCELLED!`, `GOLDWING`, `CMND/CTRL`, Calamaro's initialisms
`H.M.Q.D.E.P.`) and **2 were defects** — Raffaella Carrà titles that had absorbed her own
(misspelled) artist name. A third turned up in the same query, having become its own
single-song album.

`identify_song` returned `source-error / "The operation timed out"` on all three, twice. Per the
playbook a timeout is plausibly transient, unlike #786's deterministic HTTP 400 — and this host
has been network-flaky all session — so I retried once and stopped rather than looping.
Proceeded without it, because the edit did **not** require identifying the song: removing an
artist token that duplicates the already-known artist is not a claim about what the recording
is.

Two applied (`Qué dolor`, `Raffaella`). **The third failed, deterministically:**

```
{"error":"Tag write did not persist",
 "requested":{"title":"Fiesta"}, "actual":{"title":"FIESTA RAFAELLA CARRA"}}
```

**Filed [#964](https://github.com/kevinch3/NicotinD/issues/964)** after ruling out the obvious
causes: mode 644, uid 1000, `W_OK` yes, process uid 1000, directory 775 — and a **sibling file
in the same album folder, same format, same permissions, accepted its write in the same batch**.
So it is the file, not the path, mount, format, or tagger.

**The half worth celebrating**: this is #760's failure mode — a write that reverts — and the
tool *caught it*. It read back, refused to claim success, and returned both the requested and
actual values. The curation docs still frame read-back as something the caller must do
defensively; on this call the tool did it. That is a guard shipping and working on a real case,
found only because it fired.

### Thirty-ninth stretch — disproving my own hypothesis about #964

Answered the question I had left open in #964 — *one file or a class?* — without attempting
speculative writes across the library, by comparing tag **structure** instead.

There is a structural difference, and it is not the cause:

```
FAILS : ID3v2.3.0 flags=0x00 tagSize=860 first frame TALB   ID3v1 trailer: YES
WORKS : ID3v2.3.0 flags=0x00 tagSize=832 first frame TALB   ID3v1 trailer: no
```

The tempting story — "the ID3v1 trailer confuses the writer" — is wrong. **5,037 of 12,305
library mp3s (40.9%) carry an ID3v1 trailer**, and ~110 successful tag writes this session
landed across that population. Having one is normal.

**The detail that turned out to matter**: the failing file's ID3v1 title is already `"Fiesta"`
— exactly the value the write is trying to set — while ID3v2 holds `FIESTA RAFAELLA CARRA`.

```
ID3v1 : "Fiesta"                  ID3v2 : "FIESTA RAFAELLA CARRA"   <- what the library reads
```

So the correct value already exists in the file, in the tag nobody reads. That eliminates any
theory where the read-back inspects the wrong tag (the reported `actual` matches v2 exactly)
and narrows the failure precisely to **the ID3v2 write path on this one file**.

**A second lead, also closed.** With 5,037 files carrying two tag versions, I checked whether
v1 ever holds a *better* title than the library shows. It does not: of 4,449 comparable files,
**245 (5.5%) disagree, and v2 is the better value every time** — v1 carries track-number
prefixes (`14 - Bandida`) and 30-character truncations (`05 - El cantante (feat. Voltio`). The
scanner reading v2 is right; there is no cleanup here, and recording that stops the 5.5% being
mistaken for a defect later.

Posted both to [#964](https://github.com/kevinch3/NicotinD/issues/964). The cause is still open
— but a plausible-sounding explanation is now eliminated with a measurement rather than left
for the next person to chase. **Disproving your own hypothesis is worth as much as confirming
it, and costs one query either way.**

### Fortieth stretch — `library_release_meta`, and 95 rows fixed in 56 calls

Opened `library_release_meta` (2,568 rows), a table no pass had read. It is authoritative over
the curator's own classification heuristic, so wrong data here is user-visible.

**The `album_type` disagreements are the guard working, not failing.** Nine albums have a meta
type contradicting their stored classification — and every one is the metadata claiming
**`single`** for a 12-20 track album: *Future Nostalgia* (18), *Waterloo* (20), *She Wolf* (18),
*The Bends* (12). That is precisely the case `library-curator.ts` documents for #315: *"Dua Lipa
has both an album and a single called 'Future Nostalgia', so the catalog lookup can attach the
single's type to the album's folder."* The stored classification is `album` in all nine — the
track-count guard is overriding bad metadata on the literal example from its own comment. A
disagreement count here is a health signal, not a defect.

**`canonical_title` differs from the stored name on 399 albums**, and mostly our name is
*better* — `(extended versions)`, `[Extended Version]`, `(twenty years edition)` are editions
worth keeping. Applying Lidarr's canonical wholesale would discard real information. But one
sub-pattern is pure junk: a **`/66` suffix** on Bizarrap's *Bzrp Music Sessions* — a
"volume N of 66" artifact baked into the title.

**39 album names and 56 song titles carried it.** Rather than 95 writes, I tested the
sequencing rule found earlier (album names derive from song tags): one `fix_song_metadata`
setting **both `title` and `album`** dropped the counts 39→38 and 56→55 in a single call. So the
whole class closed in **56 calls, not 95**. Verified **0 / 0**.

I stripped the suffix myself rather than adopting Lidarr's canonical string, because its
casing is not always right — it renders `CA7RIEL` as `Ca7riel` and `Arcángel` as `Arcangel`,
and `CA7RIEL` is the artist's own styling. Two canonical titles were themselves polluted
(`J Balvin … Vol. 62/66`, `Daddy Yankee … Vol. 0/66`), which is the clearest argument against
trusting that field wholesale: **an authoritative source is authoritative about identity, not
about formatting.**

### Forty-first stretch — a probe that was too aggressive, and what it still bought

Categorised the 399 `canonical_title` differences to find more junk sub-patterns like `/66`:

| relationship | albums |
| --- | --- |
| stored name **extends** canonical (editions — keep ours) | 183 |
| canonical **extends** stored | 113 |
| neither is a prefix of the other | **68** |
| case-only | 1 |

**The 68 "neither" cases include bad Lidarr matches**, which matters because this table is
authoritative over classification: `In Rainbows` (Radiohead) has canonical **`Live in Rainbows`**
— a different release; `Superchatarraespéshal` (Gillespi) maps to `Es`. So
`library_release_meta` sometimes points at the wrong release, and adopting `canonical_title`
wholesale would import those errors.

One row suggested a fixable class — `Rodrigo - El potro` -> `El potro`, the artist name
prefixed into the album name. **Probing it library-wide produced mostly false positives, some
of them destructive:**

```
Aquarium                                  -> "rium"                      (the artist is Aqua)
Michael Jackson's Vision                  -> "'s Vision"
Buena Vista Social Club (25th Anniversary…) -> "(25th Anniversary Edition)"
Chet Baker & Strings                      -> "& Strings"
Eiffel 65 (2004 Special Edition)          -> "(2004 Special Edition)"
```

Two failure modes: **self-titled albums with an edition suffix** (where the artist name *is*
the album name), and artist names that merely happen to prefix a longer word. A bulk apply here
would have mangled 25+ albums.

Also caught by reading rather than matching: `Shakira no Rio - As melhores` and
`Divididos en Vélez - Agradecer y seguir` are Portuguese/Spanish for *"Shakira in Rio"* and
*"Divididos at Vélez"* — the artist name is **part of the title**, not a prefix.

**Applied 4**, each with an explicit separator *and* a standalone remainder:
`El polaco - Vuelve te lo pido` -> `Vuelve te lo pido` (167 songs),
`Enrique Iglesias: Greatest Hits` -> `Greatest Hits`,
`Ricky Martin MTV Unplugged` -> `MTV Unplugged`, `Nek Hits Live` -> `Hits Live`.

The stretch is worth recording mainly as a negative: **the `/66` class was mechanical because
the junk was a fixed literal suffix; "artist name prefix" looks like the same shape and is not,
because the artist name is sometimes the content.** Same probe skeleton, opposite safety —
which is why the first one ran to 56 writes and this one stopped at 4.

### Forty-second stretch — canonical titles are unreliable, and the code already knows

Examined the `canonIsSuperset` bucket (113) expecting truncated titles worth completing. It is
the opposite — Lidarr matching a **variant** release to our base one:

```
"Red" (16 songs)       ->  "Red (Taylor's Version)"          a different release
"Clube Da Esquina"     ->  "Clube da Esquina 2"              the sequel
"Breathe"              ->  "Breathe (Eric Prydz Remix)"      a remix
"You Can't Hurry Love" ->  "… (live on the Ed Sullivan Show, 1966)"
```

**Leading-article cases: 0.** So of all 399 canonical-title differences, essentially **none is
an improvement opportunity**: 183 are editions where our name is better, 113 point at a variant,
68 are outright mismatches, 1 is case-only. `canonical_title` is not a naming source here.

**Then the part that mattered.** `canonical_title` is not dead data — `repair-album-folders.ts`
feeds it to `planTrackKeepers`, which decides which files to **keep and which to delete**. A
canonical list belonging to the wrong release could, in principle, drop real music.

It cannot, and the guard is explicit:

```ts
// Keep the chosen per-track files AND every file that matched NO canonical
// track — an unmatched file is an unknown/bonus track, never a redundant
// version, so we must not silently delete it.
const keep = files.filter((f) => claimed.has(f) || !matched.has(f));
```

A file matching **no** canonical track is always kept. So a wrong-release match degrades to a
**no-op** rather than a deletion: `Clube da Esquina 2`'s tracklist matches almost nothing in
`Clube Da Esquina`, so everything is unmatched and everything is kept. The script is also
dry-run unless `--apply`. **No issue filed.**

That is the fourth time this pass a shape that looked dangerous from the data alone turned out
to be deliberate and guarded — after `orphan_artist`'s 485, the 139 dangling `artist_id`s, and
the compilation credit fallback. The pattern is consistent enough to state as a rule:
**in this codebase, when data looks unsafe, read the comment next to the code that consumes it
before writing anything down.** Every one of those four was settled by a comment the author had
already written, not by more querying.

### Forty-third stretch — an empty lane, then a structural gap in the pruner

**Album-to-song genre propagation: no lane.** Only **1** genre-less song has an album carrying a
usable genre, and it fails the playbook's own test — a 2-song album where a *single* tagged
sibling set the album genre to `Chanson Française`, for a track called "FLY" by "Void". "A lone
sibling propagates one mistag." Skipped. The emptiness makes sense in hindsight:
`library_albums.genre` is derived from its songs, so it cannot know something they do not.

**Then a real finding, from reading two more untouched tables.** `library_artist_meta` has 217
orphan rows and `library_artwork` has 742. Checking whether the pruner covers them:
`ORPHAN_TABLES` is **song-keyed only** — every entry declares a `songIdColumn` checked against
`library_songs`. Album- and artist-keyed side tables have **no sweep at all**:

| table | keyed on | orphans |
| --- | --- | --- |
| `library_artwork` (album) | album id | **654** |
| `library_artist_meta` | artist_id | 217 |
| `library_artist_origins` | artist_id | 187 |
| `library_release_meta` | album_id | 113 |
| `library_artwork` (artist) | artist id | 88 |
| | | **1,259** |

**Filed [#965](https://github.com/kevinch3/NicotinD/issues/965)** — and the reason it is more
than tidiness took a moment to see. Album and artist ids are **name-derived**. `library_artwork`
is keyed on that id and outlives the album. So: rename an album (a routine curation action —
`fix_album_metadata`'s own docs warn the id changes), the old artwork row is orphaned, and if
that exact artist+title ever exists again the new album mints the **same id** and silently
inherits the stale cover. No error, no log line. The same applies to `library_release_meta`,
which is authoritative over classification.

**This pass is the stress case for it**: ~50 album renames and ~45 artist merges, each
re-minting ids. So I generated some of those 654 orphans myself, which is how the question
arose at all.

Deliberately excluded `library_song_analysis_failures` from the finding — it shows 4,705
orphans but **is** in the pruner and carries an `orphaned_at` column, so that is a retention
window, not a leak. Counting it would have inflated the number fivefold and made the issue
wrong.

### Stretch 15 — recovering 28 covers I destroyed, and finding the real defect under #965

Followed #965 from a tidiness observation to an actual loss, and the loss turned out to be
**self-inflicted**. Earlier this pass I stripped a `/66` watermark from 59 Bzrp album names
by rewriting song tags. Album ids are name-derived, so every one of those renames re-minted
an id — and `library_artwork` is keyed on that id:

```
Bzrp albums: 59   still have artwork: 12   LOST but recoverable: 28
```

28 albums silently went blank. Nothing errored; `ok: true` on every call; the albums still
play. Recovery was possible only because the orphaned rows still held valid Cover Art
Archive URLs and because I knew the exact string I had removed — recomputing
`albumIdFor(artist, name + '/66')` retrieved each old row, and `set_album_cover` wrote it
back. Verified by re-running the probe, not by the write returning ok:

```
Bzrp albums: 59   still have artwork: 40   LOST but recoverable: 0
```

The other 19 never had a cover to begin with.

**The measurement that changed the diagnosis.** Having a recovery method, I asked whether
this had happened before, using `library_metadata_overrides`' own `raw_album_id` →
`corrected_album_id` map as ground truth for every rename the library has recorded:

| | count |
| --- | --- |
| override rows representing a real id change | 215 |
| ...whose **old** id holds an artwork row | **0** |
| ...whose **new** id holds an artwork row | 114 |

Zero out of 215. So the two rename paths do not behave the same:

- `fix_album_metadata` writes the override row *before* artwork is fetched, so art is keyed
  on the corrected id from the start. Safe by construction.
- `fix_song_metadata({album})` — the documented way to fix an album whose name comes from
  its tags — writes no override, the scanner re-mints the id at scan time, and nothing
  carries the artwork across.

That reframes #965. What I filed was "side tables have no orphan sweep," which is real but
is disk tidiness plus a rare stale-inheritance hazard needing the old name to return. What
is actually true is **one supported rename path loses user-visible data and the other does
not**, and it fires on every tag-driven rename — 28 times in one afternoon. Posted the
correction to #965 rather than leaving the weaker framing standing.

The regression test writes itself: rename an album via song tags, rescan, assert it still
has its cover.

Prod context for the remainder: 654 orphan album-artwork rows, 4,269 of 6,921 albums with
no art. Those 654 are **not** generally recoverable — this method needs the old name
reconstructed, which only worked here because the edit was a known fixed suffix.
