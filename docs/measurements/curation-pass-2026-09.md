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
