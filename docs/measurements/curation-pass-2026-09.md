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
