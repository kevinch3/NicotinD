# Curation pass — 2026-08 (calibration + tooling baseline)

Not yet a full playbook pass — the tooling (health report + MCP parity tools, PRs #739–#742)
landed this month; the first full Wave 0–5 pass runs once they deploy. This record holds the
**Step-0 calibration probes** (read-only, prod `kpc`, 2026-08-26) that froze the detector
thresholds, so the first real pass has a before-picture.

## Library totals (2026-08-26)

2,966 artists · 5,181 albums (5,173 visible) · 16,386 songs.

## Baseline per dimension

| Dimension | Measured | Note |
| --- | --- | --- |
| Album canonical covers | **2,691 / 5,173 visible missing (52%)** | grown from #694's 2,561; `artwork-backfill` is Wave 1's biggest lever |
| Missing years | 215 visible albums | |
| Visible `unknown` classification | 0 | the curator holds |
| Genre-less songs (landed) | 902 | residue after the 08-25/26 manual passes |
| Lyrics coverage | 1,476 / 16,386 (9%) | informational — fetch is on-demand by design |
| Open curation flags | 11 | ~4 researched, resolvable once `resolve_review_flag` deploys |
| Mixed-format albums | 238 | flac+mp3 / mp3+opus mixes; several look like duplicate-rip inflation |
| Low-bitrate albums (128/96 floors) | **15** | floors deliberate: a 160 floor would flag 39% of all mp3s |
| Lossless remaining | 518 songs (all flac) | = `transcode-library`'s candidate set |
| Zero-bitrate rows | 8 | probe failures — why "known bitrate" means `> 0` |
| Completeness, confirmed population | 440 done + 50 exhausted `album_jobs` (406 unique pairs) | expected-vs-owned computed per pair at report time |
| Completeness, suspected (track gaps) | **463** guarded (1,627 unguarded) | guards: distinct numbers, ≥3 owned, `maxTrack ≤ 40`; survivors sampled real (Dark Side of the Moon 8/9, Midnights 12/13) |

## Format histogram (context for the floors)

mp3 11,192 (avg 198 kbps; 40 below 128) · opus 4,402 (avg 188; 127 below 128, 4 below 96) ·
flac 518 · m4a 225 · ogg 43 · wma 6.

## Decisions frozen from these numbers

- Low-bitrate floors **128 kbps lossy / 96 kbps opus**, album flagged at ≥½ of known-bitrate
  tracks below floor, `bit_rate <= 0` = unknown.
- Suspected track-gap guards as above; bucket is **advisory-only**.
- Health report is on-demand only (never a ServiceReview slice).

## First full pass (Waves 0–5), 2026-08-26

Run before month rotation, so it stays in this file per the note above. Prod kpc v0.5.20 (all of
#739–#743/#751 live); Wave 1 (admin bulk maintenance) skipped — out of reach from a refiner-scoped
MCP session, not attempted this pass. Waves 0/2/3/4/5 run via MCP only.

### Delta (Wave 0 → Wave 5)

| Dimension | Before | After | Δ |
| --- | --- | --- | --- |
| Missing covers | 2,691 | 2,684 | −7 |
| Missing years | 216 | 204 | −12 |
| Genre-less songs | 902 | 887 | −15 (some net new from a merge surfacing 3 previously-genreless &ME tracks, since fixed) |
| Duplicate-album fragments | 1 | 0 | −1 |
| Open review flags | 11 | 2 | −9 |
| Confirmed-incomplete albums | 187 | 186 | −1 (2 enqueued; see below) |

### Wave 2 (agent) — notable fixes

- Merged the `O-Zone`/`O‐Zone` spelling fragment.
- **Per-album retag closed three cases the previous two sessions hit as hard walls** (no
  per-album-retag tool existed then; `fix_album_metadata`'s `artist` param, #741, now does):
  Bandana's two tracks under the literal `artist`/`title` placeholder bucket (both albums —
  correcting the prior session's assumption that the second one was unrelated junk; it wasn't),
  Los Pericos' *Big Yuyo* under `Unknown Artist`, and two duplicate Enrico Sangiuliano *Biomorph*
  rips under `Unknown Artist`.
  Emilia's `GTA.mp3`/`.mp3`-named tracks were disproven as junk filenames — real Lidarr/web
  evidence shows `.MP3` (2023) is the *actual* studio album title, styled as filenames throughout;
  retagged 6 songs to `album=".MP3"`, with `La_Original.mp3`→`La Original` (real title, confirmed
  by Wikipedia). No AcoustID configured on this server, so 2 residual Emilia tracks
  (`No_se_ve.mp3`, and duplicate-check leftovers) stayed unresolved — same tooling gap as before.
- 10 albums metadata-fixed (year/cover) via `lookup_album_metadata` → `fix_album_metadata`, all
  score-100 exact-title matches: Dua Lipa, Estopa, Ratones Paranoicos, Télépopmusik, El Cuarteto de
  Nos, Babasónicos ×3, Nathy Peluso, Jamiroquai, El Polaco, Héroes del Silencio, Black Eyed Peas,
  Los Enanitos Verdes, Laura Pausini, IPAUTA.
- 22 songs genre-tagged via `set_song_genre` (evidence-based: known artist scene, or title itself
  names the genre e.g. "capaz (merengueton)" → Merenguetón); one scrambled-tag song flagged instead
  of guessed (#13, new).
- **Low-confidence flags resolved via a quick web search each**, per the owner's live instruction
  to check rather than guess or skip: `&ME`/`ME` (confirmed — both tracks are real Keinemusik
  releases, ampersand eaten by a tagger; merged), `Rihanne`/`Rampage` (confirmed NOT Rihanna — no
  such song exists in her catalog; left unmerged), `Frankyeffe & Enrico Sangiuliano` billing order
  (confirmed both orders are genuinely distinct real releases; left separate), Omar Varela
  (confirmed a real artist/stage name via Wikipedia, not a reaction series; safe to genre-tag),
  `Canta Carlos Francisco Canaro` (confirmed "Canta [name]" was Canaro's real historical
  featured-vocalist credit convention; left separate).
- Owner ad-hoc instruction mid-pass: append `Downtempo` for El Búho / Nicolás Jaar catalogs where
  applicable — applied to 17 songs across both artists' full catalogs.

### Wave 4 (acquisition) — 10 hunts (session budget spent)

2 `enqueued`, 4 `already-complete`, 1 `no-candidate`, 1 `enqueue-failed`, 2 client-timed-out.
**40%+ of the confirmed-incomplete sample was already complete** — filed as #758 (worklist may be
stale relative to current canonical state, or the Lidarr `expected` count is systematically off by
one). Confirmed-incomplete budget carries over per the playbook's idempotence guarantee.

### Issues filed

- #757 — Cloudflare 502s from the origin under a ~10-call concurrent `lookup_album_metadata` batch
  (retryable; backed off informally mid-pass).
- #758 — `completeness.confirmed` worklist stale/noisy (see Wave 4 above).

### Next

Wave 1 (admin bulk maintenance: `library-sync`, `metadata-optimize`, `artwork-backfill`,
enrichment drain, `transcode-library`) still not run this month — needs an admin-scoped session,
not refiner MCP. Remaining backlog: ~2,684 coverless, ~887 genre-less, ~204 yearless, 238
mixed-format, 465 suspected completeness gaps (advisory, need curator confirmation before any
hunt) — continues next pass.

### Follow-up mini-pass, same day (Wave 2/3 only, small increment)

Re-ran `get_library_health` — open flags had grown back to 1 (#13, a new scrambled-tag find
from a prior mini-pass). Web search (cmtv.com.ar lyric archive + chordu.com, both carrying the
same literal `07 Rodrigo Bueno - El Aprendiz` string) confirmed the real song: "El Aprendiz" by
**Rodrigo** (Argentine cuartetero), track 7 of *Soy Cordobés*.

**Resolved the flag prematurely, then had to reopen it — a real product bug, filed as #760.**
`fix_song_metadata`'s `artist`/`albumArtist` writes stuck correctly ("Rodrigo"), but **`title`
and `album` did not persist**, across three separate calls (including one that returned
`ok:true, applied:{title,album}` and still reverted by the next read) — every retry snapped
back to the literal filename `CD A 2000` on read-back. Genre also silently reverted from
Cuarteto to Latin at some point, possibly the same cause. Hypothesis: a filename-fallback in
the scanner (the file is literally named `CD A 2000.opus`) re-derives title/album on rescan and
stomps the just-written tag, or an opus-specific Vorbis-comment writer bug for those two fields
only. Re-flagged as flag #14 pending the code fix; genre restored to Cuarteto (that write path
is unaffected). **Lesson for future passes: verify a metadata write by reading it back, not by
trusting the tool's own `ok`/`applied` response** — same discipline session 1 already learned
for `merge_artist`.

Also closed 4 more genre-less songs (Abel Pintos → Folclore Argentino, 18 Kilates → Reggaeton,
DJ Alan Gomez's two "Mission" tracks → Reggaeton, the latter corroborated via web search —
Buenos Aires-based reggaeton/Latin-trap DJ) — these did verify correctly on read-back. No
acquisition this round (small increment, budget not spent).

### Extended genre mini-pass, same day (many small ticks)

Continued working the genre-less worklist tick-by-tick, evidence-first (direct artist-scene
knowledge or web search), verifying every write via read-back per [[feedback_verify_mcp_writes]].
Reduced genre-less count **902 (baseline) → 803** across the session (~99 songs fixed total this
pass). Owner explicitly asked to avoid `complete_album`/acquisition for the remainder of this
session — Wave 4 skipped throughout, Wave 2 (agent metadata/genre fixes) continued.

Notable finds: DJ/producer scene tracks resolved almost entirely via one-shot web search
(Tech House / House / Deep House / Melodic House & Techno cluster: Bassel Darwish, Angrybaby,
Bart Skils & Superchumbo, Brunello, Bryan Softwell, J.V.O, Bobby Nourmand, Borai, Chris Arna,
Chrystal, Chus & Ceballos, Cloonee, Classmatic); Latin genre cluster resolved via
scene-knowledge + confirmation (Cumbia: BM, Barrabox, Chocolate, Chili Fernandez, Commanche;
Cuarteto: Banda Express, Banda XXI, Cachumba; Corridos Tumbados: Chino Pacas, Chuyin; Trap:
CA7RIEL, Clarent, CORTIS). A handful of artists (Al Fredo, Alfonso, Angelos, Anita Co, Bambu
Mambo, Banzai, Big One, Cach House, Conrado) were checked but yielded no usable genre evidence
and were left untagged rather than guessed — they remain at the top of the worklist next pass.

Pivoted to the **years** dimension once genre progress stalled on the same evidence-less names:
215 (session start) → 198. Fixed via score-100 exact-title matches only (Jamiroquai *Traveling
Without Moving* 1996, Rombai *De fiesta* 2016, Los Palmeras *El bombón asesino* 2016, Daddy
Yankee *Prestige* 2012 — the only ambiguous case, resolved by trusting Lidarr's authoritative
match over a same-titled 2025 Discogs entry that's almost certainly a different release), plus
one title-literal case (Tru La La *Exageradísimo '87* → 1987, year is in the album's own name).
Skipped ambiguous multi-candidate cases (RHCP *Greatest Hits* — several same-titled
compilations across years; Cristian Castro *Frente a frente*, Matias Aguayo *CD 01*, Recondite
*Renaissance* — no exact match in any source) rather than guess. Also flagged Chayanne's
"E D I T A R  Singles" as a likely placeholder/junk album title worth a human look, not a
genuine title to date.

Pivoted again to **covers** once the years worklist also thinned to no-exact-match cases:
2691 (session start) → 2676. All via `lookup_album_metadata` score-100 (or same-title/same-year
multi-source-agreeing) matches only: Pink Floyd *The Division Bell*, Eiffel 65's self-titled
2003 reissue, Various Artists *The People's Tenor* (Pavarotti opera compilation) and
*while(1&lt;2)* (deadmau5 compilation), Ráfaga *Lo mejor de*, RHCP *Uplift Mofo Party Plan*
instrumental demos, Miranda! *Safari* (plus 4 genre-less songs on that same album closed as a
side effect — same artist/genre, verified), Dua Lipa *Live from the Royal Albert Hall*, La
K'onga *20 Grandes Éxitos*. Skipped niche/compilation albums with no cover in any source
(Los Enanitos Verdes, IPAUTA ×2, Green Velvet DJ mix, the Welsh-language-course "album",
Seis Décadas de Rock Argentino).

**Running dimension totals this extended session**: genres 902→798, years 215→198,
covers 2691→2676. All fixes verified via read-back; no acquisition performed throughout.

Continued well past the initial stopping points with more score-100/exact-match rounds across
all three dimensions: Pink Floyd, Eiffel 65, Miranda! (+4 genre-less songs on that album),
Dua Lipa, La K'onga, ABBA *Arrival*, Karina *Miénteme* (+2 genre-less songs), Babasónicos
(*Pendejo*, *Repuesto de fe*), Los Palmeras *Un Toque Diferente*, Ráfaga *Lo mejor de*, Los
Pericos *El ritual de Los Pericos*, Los Hermanos Rosario *Los dueños del swing*, Sombras,
Latin Ska Force. Consistently skipped ambiguous/no-cover cases (RHCP *Greatest Hits*, Ed Sheeran
*÷ (Deluxe)*, Estopa *Más Destrangis* — two different-year covers for one title, Recondite,
Mano Le Tough, Shakira *Superventas 07*, various obscure compilations with no cover in any
source) rather than guess.

**Final totals this pass, 2026-08-26/27**: genres 902→796, years 215→191, covers 2691→2665,
open flags 11→0 (one false-resolve caught mid-pass and corrected — see #760 above). No
acquisition performed at the owner's explicit request for this session. Every fix verified by
reading the record back after the write, per [[feedback_verify_mcp_writes]] — the standing
practice this pass established after discovering the title/album write-persistence bug.

**Correction**: the "open flags → 0" line above was stale — flag #13 (the #760 song) was
reopened as **flag #14** once the persistence bug was confirmed, and every `get_library_health`
call since has shown `flags.open: 1`. It stays open until #760 is fixed in code; not a curation
task to close manually.

**2026-08-27 continuation**: one more genre round — DJ Tao's two remaining Turreo Sessions
songs tagged `Turreo` (web-search-confirmed: DJ Tao originated the genre via this series),
Daisybelle *Sometimes (feat. Raskavar)* tagged `Deep House` (Nervous Records release,
web-confirmed), Big One *Mentiras | CROSSOVER #3* tagged `RKT` (web-confirmed Argentine
RKT/cumbia-420 producer). All four verified via `get_album_tracks` read-back.
**Running totals**: genres 796→793 (net; some earlier ticks already folded these in), flags
still open (1, #14/#760). Stopping this tick here — remaining genre-less entries are mostly
one-off obscure tracks needing individual per-song web corroboration, diminishing returns per
search.

**2026-08-27, second tick**: Al Fredo *Luna, Agua, Tierra, Sol* → `Singer-Songwriter`
(web-confirmed), Angelos *Those Nights* → `Afro House` (Beatport + YouTube tag confirmed).
Skipped Alfonso *Late Kebabs*, Cach House/Conrado *Borracho y Loco*, Conrado *MUEVE*/*Puesto Pa
Ella*, Bambu Mambo *El Baile de las Cocoteras* — no clean single-genre corroboration found (the
last is ambiguous between "Latino Dance" and cumbia across sources). Genres now 791. Both new
fixes verified via `get_album_tracks` read-back.

**2026-08-27, third tick**: Cosha *Want You Back* → `Contemporary R&B` (web-confirmed, verified
via read-back). Skipped Copla Alta *Hablan de Ti* (folk-adjacent Uruguayan tradition, no single
clean genre) and Conrado *Rebelde* (no confirmable genre beyond a same-titled unrelated
compilation). Genres now 790.

**2026-08-27, fourth tick**: Creeds *Push Up (Main Edit)* → `Dance` (web-confirmed across
Beatsource/Last.fm/track profiles), verified via read-back. Skipped Anita Co *Besos Brujos*
(search only surfaced unrelated Anitta results). Genres now 788.

**2026-08-27, fifth tick**: Cristian Chinellato *Todo Es Amor* → `Tango` (2019 Gardel Awards
nomination for Best Male Tango Album confirms it), verified via read-back. Genres now 787.

**2026-08-27, sixth tick**: Cumbia rocha *Suena en la Previa Vol.5* → `Cumbia` (artist's own
name plus web-confirmed cumbia project from Quilmes), verified via read-back. Genres now 786.

**2026-08-27, seventh tick**: DENNIS *MOTINHA 2.0 (Mete Marcha) - Remix* → `Funk Carioca`
(web-confirmed — DENNIS is the original 2000s "Dança da Motinha" funk producer; this remix
features Luísa Sonza), verified via read-back. Genres now 785.

**2026-08-27, eighth tick — self-caught error**: applied `House` to DJ Nu-Sky *Hold On* based on
a same-named Hot Creations/Elrow tech-house producer, but a follow-up search found no "ON LIFE"
2017 album in that artist's discography — likely a *different* DJ Nu-Sky, so the genre tag is
probably wrong. No MCP way to unset a genre once applied; flagged the song for human review
(**flag #15**) rather than leave an unverified guess silently in place. Flags now 2 open
(#14/#760, #15/DJ Nu-Sky genre).

**2026-08-27, ninth tick**: DJ Wady *Hulk (Camelphat 2017 Re-Fix)* → `Tech House`
(web-confirmed: Beatport/Cr2 Records release, CamelPhat's own SoundCloud repost), verified via
read-back. Genres now 783.

**2026-08-27, tenth tick**: Daniel Cardozo *Inventame* → `Cumbia` (web-confirmed: CumbiaBase
biography lists him as a cumbia/cuarteto tropical-movement singer), verified via read-back.
Genres now 782.

**2026-08-27, eleventh tick**: Daniel Orpi *Touch Me EP* → genre `Tech House` (web-confirmed:
Beatport/Kaluki Musik release, RA bio) plus its cover (exact-title/year Discogs match, score-100
tags match), both verified via read-back. Genres now 781, covers now 2667.

**2026-08-27, twelfth tick**: Dateless *Cuando Mueves* → `Tech House` (web-confirmed:
Beatport/Traxsource/Safe Music release, score-100 Lidarr match on the exact 2017 EP), verified
via read-back. Genres now 780.

**2026-08-27, thirteenth tick**: Dazed *Así* → `House` (web-confirmed: house-music DJ duo,
decibeles.net profile), verified via read-back. Genres now 779.

**2026-08-27, fourteenth tick**: De La Swing & Nico Ferrada *Together / Fireworks* EP →
`Tech House` for both tracks (*Fireworks* + *Together*, same artist/EP — web-confirmed:
Traxsource release, Gray Area techno/house profile) plus its cover (exact-title/year Discogs
match), all verified via read-back. Genres now 777, covers now 2666.

**2026-08-27, fifteenth tick**: Dean & Britta *Million Dollar Doll* (from *Frances Ha* OST) →
`Indie Pop` (web-confirmed: Wikipedia genre, synthpop-jam description), verified via read-back.
Genres now 776.

**2026-08-27, sixteenth tick**: Deeper *Willing* (from *Auto-Pain*) → `Post-Punk` (web-confirmed:
Chicago post-punk trio, multiple press profiles/Bandcamp), verified via read-back. Genres now
775.

**2026-08-27, seventeenth tick**: DesaKTa2 *La Diabla* → `Cuarteto` (web-confirmed: Córdoba,
Argentina cuarteto group, multiple sources), verified via read-back. Genres now 774.

**2026-08-27, eighteenth tick — another #760 instance found**: "Despues de ti" / "Los del Fuego │
LETRA" is scrambled tags (reversed artist/title; real artist Los del Fuego, real title "Después
de Ti", a 2004 Cumbia Santafesina track per web search). `fix_song_metadata` on title+artist+
albumArtist returned ok:true; read-back showed **artist persisted** (new album re-minted under
"Los del Fuego") but **title reverted** to the scrambled filename — the exact #760 pattern,
confirmed on a second song. Flagged for human follow-up (**flag #16**) rather than retry; genre
`Cumbia Santafesina` applied separately (independent of the naming bug) and verified. Genres now
773, flags now 3 open (#14/#760, #15/DJ Nu-Sky, #16/Los del Fuego title).

**Note**: the metadata rescan from the #16 fix attempt bumped the worklist's ordering/count
(album total 5178→5179, genres-missing jumped 773→780 as new/reordered entries surfaced) —
denominator noise from a rescan, not new pollution; the running per-tick deltas below are correct
relative to the fresh counts.

**2026-08-27, nineteenth tick**: three more score-100/high-confidence genre fixes, all verified —
18 Kilates *Con La Misma Canción* → `Cumbia Pop` (web-confirmed Argentine cumbia-pop group),
Angrybaby *WASTED ON ME* → `Deep House` (web-confirmed: Beatport, "emotional deep house gem"),
Bart Skils & Superchumbo *All Over My Body (Danny Avila Remix)* → `Techno` (Drumcode release,
techno-classified per Beatportal). Genres now 777.

**2026-08-27, twentieth tick**: Angela Leiva ft Daniel Cardozo *Invéntame* → `Cumbia`
(web-confirmed: Ángela Leiva is Argentina's "reina de la cumbia"), Anna Ullrich *Exil* and *I
Dont Wanna Go (feat. No.Ri)* → `Techno` (web-confirmed: Vienna DJ, deep techno/melodic trance
sets), Chili Fernandez *El Soy Yo* → `Cumbia` (web-confirmed: cumbia romántica classic) plus its
cover (exact-title/year Discogs match). All four verified via read-back. Genres now 773, covers
now 2666.

**2026-08-27, twenty-first tick**: Destino San Javier *Eterno Amor (En Vivo)* → `Folclore`
(web-confirmed: Argentine folclore/chacarera romántico group, Gardel Award + Viña del Mar
winners), verified via read-back. Genres now 772.

**2026-08-27, twenty-second tick**: Destino San Javier *Tú Sí Sabes Quererme* → `Folclore` (same
artist, evidence carries over), verified via read-back. Genres now 771.

**2026-08-27, twenty-third tick**: Diddy *I'll Be Missing You (feat. Faith Evans, 112)* →
`Hip Hop` (well-known 1997 hit, no search needed), verified via read-back. Genres now 770.

**2026-08-27, twenty-fourth tick**: Diego Sosa *Shake That Ass* → `Tech House` (web-confirmed:
Beatport/La Pera Records release, tech-house/deep-tech producer), verified via read-back. Genres
now 769.

**2026-08-27, twenty-fifth tick**: Disco Lines *No Broke Boys* → `Electro House`
(web-confirmed: multi-source dance/house classification of the Tinashe remix hit) plus its
cover (score-100 Lidarr match), both verified via read-back. Genres now 768, covers now 2665.

**2026-08-27, twenty-sixth tick**: Dj Nacho Serra *512v* → `Latin House` (web-confirmed: Buenos
Aires Latin House/tech house pioneer), verified via read-back. Genres now 767.

**2026-08-27, twenty-seventh tick**: Djo *End of Beginning* → `Indie Pop` (well-known 2022 hit,
Joe Keery's indie-pop project) plus its cover (score-100 Lidarr match), both verified via
read-back. Genres now 766, covers now 2665 (net; also picked up an untouched item elsewhere).

**2026-08-27, twenty-eighth tick**: Dom Dolla *Addicted To Bass (Dom Dolla Relapse)* →
`Tech House` (well-known Australian tech-house producer, no search needed), verified via
read-back. Genres now 765.

**2026-08-27, twenty-ninth tick**: Draxx (ITA) *Bad 2 Good* → `Tech House` (web-confirmed:
Beatport/Divided Souls release, "Dirty Tech House" playlist), verified via read-back. Genres
now 764.

**2026-08-27, thirtieth tick**: Dream Stars *Pop Makossa* → `Makossa` (web-confirmed: Analog
Africa's *Pop Makossa* Cameroonian compilation, No. 23), verified via read-back. Genres now 763.

**2026-08-27, thirty-first tick**: Drew Jurecka *Russian Lullaby* → `Jazz` (web-confirmed:
Toronto jazz violinist performing the Irving Berlin standard), verified via read-back. Genres
now 762.

**2026-08-27, thirty-second tick**: E. D. Baker *Porque Te Amo* → `Cumbia` (web-confirmed:
matches "La Cumbia — Porque te Amo" chord/video sources), verified via read-back. Genres now 761.

**2026-08-27, thirty-third tick**: ECKO (feat. Los Turros & DobleP) *Loquita - Remix* → `RKT`
(web-confirmed: Los Turros is a cumbia villera/RKT act, cumbia-420/reggaeton crossover), verified
via read-back. Genres now 760.

**2026-08-27, thirty-fourth tick**: EL DE LA TINTA (feat. Gabito Ballesteros) *holanda - Remix*
→ `Corridos Tumbados` (web-confirmed), verified via read-back. Genres now 759.

**2026-08-27, thirty-fifth tick**: ELENA ROSE *ALMA* + *AMÉN BEBÉ* (same *Bendito Verano* album)
→ `Latin Pop` (web-confirmed: Venezuelan Latin-pop/urban-contemporary singer), both verified via
read-back. Genres now 757.

**2026-08-27, thirty-sixth tick**: ENNE (BR) *Maracatu* → `Maracatu` (web-confirmed: Brazilian
Afro-Pernambuco carnival genre, matches the song title directly), verified via read-back. Genres
now 756.

**2026-08-27, thirty-seventh tick**: Eddie Chacon *Above Below* → `Soul` (web-confirmed:
"celestial soul" R&B artist, ex-Charles & Eddie, Bandcamp/Apple Music), verified via read-back.
Genres now 755.

**2026-08-27, thirty-eighth tick**: Eduardo Vargas *Move Party* → `Tech House` (web-confirmed:
Caracas-based tech-house/afro-house DJ-producer), verified via read-back. Genres now 754.

**2026-08-27, thirty-ninth tick**: El Arrebato *Quiero Que Escuches* → `Rumba Flamenca`
(web-confirmed: Sevillian rumba/pop/flamenco group), verified via read-back. Genres now 753.

**2026-08-27, fortieth tick**: El Cachivache Quinteto *Gipsy Vals* → `Gypsy Jazz` (web-confirmed:
Argentine tango-punk quintet's gypsy-waltz instrumental from *Justo a Tempo*), verified via
read-back. Genres now 752.

**2026-08-27, forty-first tick**: El Dipy *Bum Bum* → `Cumbia Pop` (well-known Argentine cumbia
pop artist, direct knowledge), verified via read-back. Genres now 751.

**2026-08-27, forty-second tick**: El Gordo Luis *Cinco Minutos* → `Cumbia Santafesina`
(web-confirmed: CumbiaBase biography), verified via read-back. Genres now 750.

**2026-08-27, forty-third tick**: El Mago y La Nueva *O Me Voy O Te Vas* → `Cumbia`
(web-confirmed), verified via read-back. Genres now 749.

**2026-08-27, forty-fourth tick**: El Reja (feat. El Super Hobby) *Los Fiesteros Se Enamoran* →
`Cumbia` (web-confirmed: Argentine cumbia track), verified via read-back. Genres now 748.

**2026-08-27, forty-fifth tick**: El Reja *Siéntelo* → `Cumbia` (same artist, evidence carries
over), verified via read-back. Genres now 747.

**2026-08-27, forty-sixth tick**: El Rodri *Relación / Tus Besos / Sensación del Bloque* →
`Cumbia` (web-confirmed: Argentine cumbia/RKT artist), verified via read-back. Genres now 746.

**2026-08-27, forty-seventh tick**: El negro tecla *Ahi Ahi* → `RKT` (web-confirmed: Mendoza
cumbia-RKT revelation, viral remix with L-Gante/Pablo Lescano/DJ Tao), verified via read-back.
Genres now 745.

**2026-08-27, forty-eighth tick**: El negro tecla *La Noche* → `RKT` (same artist, evidence
carries over), verified via read-back. Genres now 744.

**2026-08-27, forty-ninth tick**: Ela Taubert *¿Cómo Pasó?* → `Pop` (web-confirmed: Latin
Grammy/Premio Lo Nuestro Pop Song of the Year) plus its cover (score-100 Lidarr match), both
verified via read-back. Genres now 743, covers now 2665.

**2026-08-27, fiftieth tick**: Eli Brown, Pan-Pot *Coming In Heavy* → `Tech House` (well-known
tech-house/techno producers, no search needed), verified via read-back. Genres now 742.

**2026-08-27, fifty-first tick**: Elias (feat. Frans) *Who's Da' Man - Swedish Version* →
`Pop;Reggae` (web-confirmed: 2006 Swedish pop/reggae single), verified via read-back. Genres now
741.

**2026-08-27, fifty-second tick**: Ellen Krauss *Inatt (Inget Stoppar Oss Nu)* → `Dansband`
(web-confirmed: cover of a BlackJack dansband classic) plus its cover (score-100 Lidarr match),
both verified via read-back. Genres now 740, covers now 2665.

**2026-08-27, fifty-third tick**: Elza Laranjeira *Serenata do Adeus* → `Bossa Nova`
(web-confirmed: Jobim/Vinícius de Moraes-era Brazilian standard), verified via read-back. Genres
now 739.

**2026-08-27, fifty-fourth tick**: Emanero *BANDIDO* → `Trap` (web-confirmed: Argentine
hip-hop/trap/rap MC, veteran of the 2000s Argentine hip-hop scene), verified via read-back.
Genres now 738.

**2026-08-27, fifty-fifth tick**: Emanero *Podés pedirme perdón* → `Hip Hop` (same artist,
evidence carries over), verified via read-back. Genres now 737.

**2026-08-27, fifty-sixth tick**: Emilia *GTA.mp3* → `Urban Pop` (web-confirmed: urban
pop/house-fusion single, Sony Music) plus its cover (score-100 Lidarr match), both verified via
read-back. Genres now 736, covers now 2664.

**2026-08-27, fifty-seventh tick**: Emily Zuzik + Tim Lefebvre *Walk Away* (from *Domestic
Blitz*) → `Electronic` (web-confirmed), verified via read-back. Genres now 735.

**2026-08-27, fifty-eighth tick**: Endangered Blood *Rare* → `Avant-Garde Jazz` (web-confirmed:
NYC avant-jazz quartet, Skirl Records), verified via read-back. Genres now 734.

**2026-08-27, regression discovered — filed #762**: `get_library_health` genres.missing jumped
734→988 mid-session with no acquisition/import activity; previously-fixed songs (18 Kilates,
Al Fredo, etc.) reappeared in the worklist. Checked directly: 18 Kilates' genre had reverted
from the curated "Cumbia Pop" to a generic "Music" placeholder. This is a *new* failure mode,
distinct from #760 — not a write that never persisted, but a **previously-verified write later
silently clobbered**, almost certainly by a library rescan re-reading file tags and overwriting
the DB-only curation value (i.e. `set_song_genre` doesn't round-trip into the file itself).
Filed as **#762** rather than continuing to apply more fixes that this same mechanism could
discard invisibly. Pausing the fine-grained genre-fix loop pending that investigation — the
55+ genre fixes already logged in this doc may need to be re-verified/re-applied once #762 is
resolved.

**2026-08-27, continued after #762**: count actually settled at 745 (not the 988 spike, which
looks transient — mid-rescan noise), and only a handful of previously-fixed songs (18 Kilates,
Al Fredo, Angela Leiva, Anna Ullrich x2) reverted, not a full wipe. Re-applied 18 Kilates *Con La
Misma Canción* → `Cumbia Pop` (same prior evidence), verified via read-back. Genres now 744 —
noting this fix may revert again until #762 is fixed; not chasing every reverted item
mechanically, just resuming forward progress.

**2026-08-27, re-applied 4 more reverted fixes**: Al Fredo *Luna, Agua, Tierra, Sol*, Angela Leiva
*Invéntame*, Anna Ullrich *Exil*, Anna Ullrich/No.Ri *I Dont Wanna Go* — all re-applied with the
same prior evidence, all verified via read-back. Genres now 740.

**2026-08-27, re-applied 2 more**: Bart Skils/Superchumbo *All Over My Body* → `Techno`, Chili
Fernandez *El Soy Yo* → `Cumbia` (cover survived intact), both verified via read-back. Genres
now 738.

---

## Session 4 — 2026-08-27 (MCP, structural pass)

Ran deliberately **away from** the fine-grained genre loop the previous session ended in. Reason,
established before touching anything: PR #773 (the #770 genre-set durability fix) was merged on
`master` but **in no release tag at the time of the check**, so prod could not yet have it — every
`set_song_genre` on a song whose file tag carries no genre was still wiped by the next rescan, which
is exactly why the five songs at the head of the genre worklist were the ones fixed and logged last
session. This session therefore spent itself on dimensions whose fixes are durable by construction
(`library_metadata_overrides` and canonical cover URLs both survive a rescan).

**Correction, later the same session.** That check raced the pipeline. Releases here are automatic:
`ci.yml`'s release job tagged **v0.5.27** at 16:59Z (~6 min after #773 merged) and `deploy.yml`
verified the host at 17:05Z — `Deploy verified: /api/health reports 0.5.27`. **#773 is live.** The
reusable lesson inverts the one first written here: a local `git tag --contains` races the release
job by minutes, so check `gh run list` or prod's `/api/health` before declaring a fix unshipped.
Genre gap-filling for tag-less songs is durable from v0.5.27 on; songs whose file tag holds a
real-but-wrong genre stay exposed to **#762**, which is still open.

### #760 is fixed on prod — both stuck flags cleared

PR #765 ("make retags land on opus", v0.5.25) is **live and verified**: `fix_song_metadata` now
persists `title`/`album` on `.opus`, read-back confirmed on both flagged songs.

- **Flag #14** (Rodrigo, filename `CD A 2000.opus`) — title `El Aprendiz` now persists. Flag #13's
  album attribution was **wrong**: the file is track 07 of *A 2000*, not *Soy Cordobés* (the YouTube
  source title is literally `07 Rodrigo Bueno - El Aprendiz - CD A 2000`). Re-pointed into the
  library's existing `Cuarteto Característico (A2000)`, which held tracks 1-6 and 8 — **this orphan
  was its missing track 7**. Album 7 → 8 tracks.
- **Flag #16** (Los del Fuego) — title `Después de Ti` + artist now persist. Resolved.
- **Flag #15** (DJ Nu-Sky) — *not* resolved; updated with sharper evidence instead. MusicBrainz holds
  exactly one DJ Nu-Sky release (*Latino Mix*, 2008, a Latin DJ-mix CD); Beatport's *Nu Sky* is a
  Brooklyn tech-house producer; neither has an "ON LIFE", and the song is track **32** of it at
  128kbps — a mix-comp rip. The two candidate identities imply different genres, so the `House` tag
  stays unconfirmed. Not guessed.

### The IPAUTA watermark bucket — eliminated

`IPAUTA` (a download-site watermark sitting in the *artist* field, the #705 shape) owned 6 albums /
56 songs. All re-attributed, none deleted; the artist is now **absent from the library**.

| Was | Now | Evidence |
| --- | --- | --- |
| IPAUTA — Mas Flow 2 (23) | Luny Tunes — *Más Flow 2* (2005) + cover | Lidarr score-83; tracklist match |
| IPAUTA — Mas Flow (20) | Luny Tunes — *Más Flow* (2003) + cover | same lookup |
| IPAUTA — IPAUTA (10) | Jamsha — *El Rey de las Yales* (2013) | all 10 titles, in order, match the release |
| IPAUTA — Pa'l mundo (1) | Wisin & Yandel — *Pa'l Mundo* | merged into the real 18-track album |
| IPAUTA — Fuera de serie Live (1) | Lito y Polaco — *Fuera De Serie (En Vivo)* (2004) | track 16 matches; MB confirms the "Live" suffix was **right** |
| IPAUTA — Los patrones… vol. 2 (1) | Various Artists, compilation, 2005 + cover | MB VA compilation |

Two orphan singles (`Rakata`, `Manigueta`) folded into the real *Pa'l Mundo* as a side effect.

### Duplicate rips — 29 files deleted (owner-approved mid-pass)

Consolidating buckets *surfaces* duplicates; the owner's ruling was **delete the redundant copy,
keep the best**. Where nominal bitrate conflicted with metadata quality across codecs (mp3 320 vs
opus ~200, perceptually a wash), the coherently numbered / format-cohesive copy was kept.

- **deadmau5 — while(1<2)**: the `Deadmau5 - How To Destroy Angels - Nine Inch Nails` bucket (a
  YouTube uploader credit line) was a duplicate rip of an album already owned. 16 of its 17 tracks
  were dupes → deleted; the 17th, **Silent Picture, was genuinely missing** and is now recovered.
- **Ana Tijoux — Kaos**: `Anita Tijoux` merged into `Ana Tijoux` (`merge_artist`, kind `merged`),
  collapsing two copies of *Kaos* into one 24-track album → 10 dupes deleted, leaving exactly the
  real 14-track release (13 opus + 1 FLAC, cover set).
- **ARTBAT — Upperground**: `SharingDB.top` (another warez watermark) held the same 3 tracks as
  ARTBAT's properly tagged, numbered, covered copy → 3 watermarked files deleted.

### Covers — 10 set, all canonical URLs

`remote-cover.ts` allowlists `coverartarchive.org` and `archive.org`, not just `images.lidarr.audio`
— so a MusicBrainz release MBID → `coverartarchive.org/release/<mbid>/front-500` is a first-class
`set_album_cover` source when Lidarr has no candidate. Queried MB/CAA directly (sequential, 1 req/s)
rather than batching `lookup_album_metadata`, per **#757**; zero origin 502s this pass.

Set: Ed Sheeran *÷*, Pink Floyd *The Wall*, Rihanna *Good Girl Gone Bad: Reloaded*, Spice Girls
*Spice*, The Beatles *Help!*, The Beatles *With the Beatles* (title also de-junked from "With The
Beatles full album", year 1963), Estopa *Más destrangis*, Pescado Rabioso *Obras Cumbres*, Thalía
*Thalía*, Ana Tijoux *Kaos*, Cultura Profética *En bucle*. No art exists for: Los Enanitos Verdes
*Obras cumbres* (Lidarr score-100, `coverUrl: null`), Los Chalchaleros *Una leyenda*, La Delio
Valdez, Tru La La, La Combo Tortuga.

### Filed

- **#774** — `library_albums.song_count` goes stale after a single-song delete. `deleteOne` drops the
  `library_songs` row but never refreshes the parent album's aggregate; only the whole-album path
  cleans up. Measured twice here: while(1<2) listed 24 songs under a header of 40, Kaos listed 14
  under 24 — each time exactly the pre-delete count. It is the `owned` side of completeness, so a
  curator who dedupes then reads the health report gets a wrong denominator. Sibling of #771.
- **Flag #17** — `Cwrs Cymraeg - Recordings` / Linguaphone, 125 tracks of a Welsh language course.
  It is the head of *both* the coverless and year-less worklists and no bulk task can ever fix it
  (no such release exists). Owner picks: delete / hide / accept. Not acting unilaterally per #705.

### Delta

| Dimension | Before | After |
| --- | --- | --- |
| Album covers missing | 2663 | 2654 |
| Open review flags | 3 | 2 (2 resolved, 1 updated, 1 new) |
| Genres missing | 746 | 736 |
| Watermark artists (IPAUTA, SharingDB.top) | 2 | 0 |
| Duplicate audio files | — | 29 deleted |
| Artists | 2963 | 2978 |

Audit `high` rose 69 → 73 (`album_count_mismatch` 56→57, `missplit_album` 7→8, a new
`album_song_count_mismatch`): expected churn from re-bucketing plus #774's stale aggregates. It
should settle on the next full scan — **worth re-checking at the top of the next session** rather
than treated as new pollution.

### Next session

1. Re-check audit `high` after a scan; if `album_song_count_mismatch` persists, #774 is biting.
2. Genre gap-filling is **unblocked** — v0.5.27 (the #770/#773 fix) deployed at 17:05Z this same
   day. Re-apply the fixes session 3 logged and session 4 found reverted (18 Kilates, Al Fredo,
   Angela Leiva, Anna Ullrich ×2 …) and expect them to hold this time; a song whose file tag carries
   a real-but-wrong genre is still exposed to #762.
3. Wave 1 (admin bulk: `artwork-backfill` would clear far more than 10 covers at a time) still needs
   an admin-authenticated pass; it is out of reach from a refiner MCP session, and this is now the
   third month it has been skipped.

### Session 4b — genre lane resumed (same day, after v0.5.27)

With #773 live, the genre lane reopened. **28 songs tagged, all via `mode: 'replace'`**, and the
count moved 736 → 716 with every previously-reverted song gone from the worklist head.

**The mode matters, and not for the reason first assumed.** `set_song_genre` has two durability
contracts (`services/song-genre-mutate.ts`):

- `append` (the default) writes only `library_song_genres` — the volatile store.
- `replace` writes a **song-scoped row in `library_genre_overrides`**, which the scanner applies at
  scan time. The code comment is explicit: the tag mirror "is then a convenience for external
  players, not the durability mechanism".

Post-#773 an `append` on a **tag-less** song is preserved too (a rescan resolving nothing no longer
wipes the set), so `append` was *not* the cause of this month's treadmill — #770 was. The modes
still diverge on the **#762** case: a song whose file tag holds a real-but-wrong genre makes the
rescan resolve *something*, replacing the set and losing an `append`, while an override survives.
**Operating rule: a curator genre decision uses `replace`.** An automated detector appending an
extra genre is still correctly `append`.

Re-applied (had reverted pre-#773, same prior evidence): 18 Kilates `Cumbia Pop`, Al Fredo
`Singer-Songwriter`, Angela Leiva `Cumbia`, Anna Ullrich ×2 `Techno`, Bart Skils/Superchumbo
`Techno`, Chili Fernandez `Cumbia`, El Mago y La Nueva `Cumbia`, El Rodri `Cumbia`, Eli Brown/Pan-Pot
`Tech House`, Angrybaby `Deep House`.

Newly researched (one web search each, per the standing search-don't-guess policy): Bolaget
`Pop` (Warner press release calls it pop, explicitly *not* dansband), Bambu Mambo `Cumbia`,
Eugenia Quevedo/Ángela Leiva `Cuarteto;Cumbia` (cuarteto×cumbia collab, La Banda de Carlitos),
Anita Co `Tango` (a 1937 Malerba/Sciammarella tango, with Lito Vitale), Ernesto Jodos `Jazz`
(*La mirada detenida*, 2018), Copla Alta `Folclore`, Facundo Toro `Folclore`, Exploded View
`Post-Punk;Krautrock` (Anika's own description), Falsa Cubana ×3 `Ska;Cumbia` (Patagonian
ska/cumbia/reggae band), FAFF `Tech House` (Beatport, ec2a), FISHER ×2 `Tech House` (artist-level),
Conrado ×3 + Cach House `Tech House` (the ThomyDomé/Tomi Reig "techengue" latin-tech cluster —
artist-level, the weakest evidence in this batch).

**Researched but left untagged** — a real search returned nothing conclusive, so no guess: Alfonso
*Late Kebabs*, Banzai *Noche De Estrellas* (the title is a Ráfaga cumbia standard but nothing ties
this "Banzai" to it), Ennio *Make It Smooth*, FIA *IT GIRL*. The health worklist is already the
tracker for these; no flag raised.

### Session 4c — 5-minute loop, ticks 1-5

Owner started a `/loop 5m continue`. Worked the genre worklist alphabetically (it is ordered by
artist), with cover and identity fixes taken opportunistically when the worklist surfaced them.
**Genres 708 → 677.** All genre writes used `mode: 'replace'` per the 4b rule.

- **Tick 1** — 13 Falsa Cubana tracks `Ska;Cumbia` (artist-level evidence from 4b). Two titles had a
  **leading space** in the tag (` Correte Nena`, ` Viento En Contra`) — trimmed via
  `fix_song_metadata`. Checked the `Pipa & Fernet` / `Pipa Y Fernet` pair: **not** a duplicate, they
  sit on different albums. No CAA art exists for any of the band's four albums.
- **Tick 2** — 9 genres (Future ×2, Freenzy Music ×3, Franky Rizardo, Fatoumata Diawara, Falsa
  Cubana ×2). One **scrambled-tag record repaired**: artist field held `Fatoumata Diawara - Wililé`,
  title field held only `feat. Toumani Diabaté` → corrected to *Wililé (feat. Toumani Diabaté)* /
  *Fatou* (2011); it folded into her real *Fatou* album. Same family as flags #14/#16, so that
  tag-scrambling shape is still arriving. **4 duplicate files deleted**: `Fenfo (Something to Say)`
  was a phantom EP whose 4 tracks all exist in the real *Fenfo*, three of them as FLAC there.
- **Tick 3** — 9 genres, every one sourced to a Beatport/Discogs/RYM release page rather than
  inferred (Faux Fur, Ferra Black ×2, Federico Ambrosi, Francesco Poggi, Francis De Simone, GENNARO,
  Flo Good Inc., Fred Williams `Soul;Northern Soul`).
- **Tick 4** — covers batch. **3 applied** on exact release matches (Almafuerte *Toro y pampa*,
  Laura Pausini *Primavera anticipada*, María Becerra *La Nena de Argentina*). **2 refused**:
  MusicBrainz returned *Bizarrap's* "Residente: Bzrp Music Sessions Vol. 49" at score 100 for every
  phrasing of a Residente query, and the BEP combined 2-CD edition could not be told apart from six
  "The Beginning" editions — applying either would have put wrong art on a real album. Also
  canonicalized `Maria Becerra` → `María Becerra` via `merge_artist`'s **rename** path (MBID, AR
  origin and all four albums verified intact afterwards).
- **Tick 5** — 13 genres (Gordo ×3, Guille Placencia, Guillermo Fernández `Tango`, Gianluca Motta,
  GREG 99, George Taylor (UK), Greg Santos, Gabriel Rojas, Grupo Play, Grupo Trinidad, Grupo Uno)
  plus a year fix (Grupo Uno *Eres* → 2014, off the years worklist).

**#774 corroborated and self-limiting**: `album_song_count_mismatch` appeared in the audit (0 → 2)
right after the tick-2 deletions and had **dropped back off entirely** by tick 5, without
intervention. So the stale aggregate is real but transient — it survives only until the next scan.
That bounds the issue's severity: it misleads a curator who reads the health report *between* a
delete and the next scan, which is exactly the dedupe-then-measure loop this playbook prescribes.

**Untagged after a real search** (no guess made): Alfonso *Late Kebabs*, Banzai *Noche De Estrellas*,
Ennio *Make It Smooth*, FIA *IT GIRL*, Fat Papi *FREAKED OUT*, Flash *Lifetime* / *Morning Haze*.
The `Flash` pair is the instructive one — the name matches both a prog-rock band (with an acoustic
"Morning Haze") and an electronic artist, and the library gives no tiebreak because each track sits
alone in a single-song album of the same name.

### Session 4d — loop ticks 6-11

**A live ingest started mid-loop** (tick 6): totals jumped +31 albums / +43 songs and
`album_count_mismatch` spiked 57 → 186. `list_recent_songs` identified it as a Green Velvet
*Unshakable* landing over ~90 min. **Destructive work was suspended until it stopped** (tick 8) —
mid-ingest a "duplicate" can be an in-flight partial, and the playbook's ordering is ingest → curate.

**Tooling change that paid off:** switched the genre lane from `get_library_health` to
`list_recent_songs(missingGenre: true)`. Far cheaper per call and better prioritized — it surfaces
*recently landed* genre-less songs instead of walking the alphabet, i.e. it curates what just
arrived. Use it as the default genre worklist; keep `get_library_health` for the other dimensions
and for delta measurement.

**Two long-standing stragglers closed** (tick 8). Memory listed Mares, Ellen Krauss and Tjuvjakt as
genre residuals that "didn't resolve via search" in session 2. **Mares** → `Indie Pop` (a Swedish
indie pop band from Uppsala, 2014-2022) and **Tjuvjakt** → `Hip Hop;Pop` (Swedish hip hop group;
the 2025 single with Fanny Avonne topped the Swedish charts). Both failed earlier because the names
are generic without the Swedish-language context — searching in the artist's own language is the
trick worth reusing.

#### The Green Velvet *Unshakable* case (ticks 9-10) — flag #18

Worth recording in full: it is a compact example of nearly every failure mode this playbook exists
for, in one album.

- **Two rips in one album**: a complete 13-track FLAC set (~900-1075 kbps) and a partial 6-track
  mp3-320 set whose titles still carried `01 `/`06 ` filename prefixes. The mp3s were a strict
  subset → 6 deleted under the FLAC-wins rule.
- **Label-as-genre**: all 13 FLACs carried `Relief Records` — Green Velvet's own label — in the
  genre field. Replaced on the 8 tracks with real evidence (per-track genres from the mp3 rip about
  to be deleted, the fragment copies, and Beatport). 5 still carry it; Beatport 403s on direct fetch.
- **Collaboration credit vs duplicate policy — the real finding.** Tracks 2/10/13 existed twice at
  *identical* bitrates: once in-album credited bare "Green Velvet", once as a standalone 1-track
  album carrying the true credit (Gary Beck / Saso Recyd / Phil Kieran). Beatport shows the release
  is Green Velvet **with 13 collaborators** — essentially every track is a collab, and the library
  holds credit for only **3 of 13**, purely because those three landed as fragments. So the normal
  dupe policy (delete the fragments) would take the album from 3/13 credits to **0/13**. Flagged
  (#18) instead of acted on.
- **Attempted fix that did not take**: `fix_song_metadata` with `artist` = the comma-compound and
  `albumArtist` = `Green Velvet` returned `ok:true`, but a read-back still shows bare "Green Velvet"
  and `search_library("Gary Beck")` still finds only the fragment. Most plausible cause is
  `splitArtists` collapsing the compound to its primary — **documented behaviour, so NOT filed as a
  bug** — but it means a collaborator credit cannot currently be added to an in-album track from the
  MCP surface. That is the actual capability gap, and it is what forces #18 to a human.

**Genre tags applied, ticks 6-11**: ~45 songs, every one sourced (Beatport/Discogs/RYM/label pages
or the artist's own language press). Corrected one of my own earlier tags: *Robots* is Green Velvet
& Riva Starr, which Beatport lists Tech House, not the `House` I had taken from the mp3 rip's tag —
**a rip's own tag is weaker evidence than the release page.**

**Researched but deliberately untagged (10)**: Alfonso *Late Kebabs*, Banzai *Noche De Estrellas*,
Ennio *Make It Smooth*, FIA *IT GIRL*, Fat Papi *FREAKED OUT*, Flash *Lifetime* / *Morning Haze*,
Wrytzy, Kilometro1 *The Age of Kings*, Ivy *There It Is*. Common shape: a generic artist name plus a
single-song album of the same name, so there is neither sibling context nor a distinguishing
release to look up. These are `genre-audio` candidates — the problem is *identification*, not
missing metadata, so no amount of lookup will close them.

### Session 4e — naming standardization

Owner instruction mid-session: *"the remastered label or other ones just don't add value."* Treated
as a curation dimension in its own right — the health report does not measure it.

**The rule** (worth keeping, it is the whole safety argument):

| Strip | Keep |
| --- | --- |
| `(Remastered)`, `- Remastered 2009`, `2006 Remastered Version`, `Rudy Van Gelder Edition` | `Demo`, `Live`, `Session`, `Acoustic`, `En Vivo`, `Edit` |
| `(Official Video)`, `(Video Oficial)`, `(Visualizer)`, `(Official Music Video)` | `Remix`, `Radio Edit`, `Extended Mix`, `Original Mix` |
| `full album`, `NN ` track prefixes, `Artist \|` prefixes, site watermarks, stray `❌` | feature credits (`ft.`, `feat.`), edition markers (`Deluxe Edition`, `20th Anniversary`) |

**Why the "keep" column exists**: Evanescence holds *Bring Me To Life* four times, distinguished
ONLY by the suffix (`- Remastered 2023`, `- Demo / …`, `- AOL Session / …`, `- Live On Triple M's
Garage Session / …`). A blind strip collapses four real recordings into four identical titles that a
later dedupe pass would read as duplicates. Verified after the fact: all four survive distinctly.

**Done** (verified by re-searching each pattern, not by trusting return values):
`(Visualizer)` 10 songs + 10 albums · `(Video Oficial)` 19 + 20 · `(Official Video)` 20 + 14 — all
three patterns now return **zero** results. Plus 50 `Remastered` album names and ~80 song titles.

**Incidental finds**
- A third watermark site after IPAUTA and SharingDB.top: **`djdownloadme.com`**, 2 albums, both
  single *Anenoa* tracks → re-pointed into the real album.
- Two more scrambled records of the flag #14/#16 shape (artist field holding `Artist - Title`):
  Lilly Palmer *New Generation*, and earlier Fatoumata Diawara *Wililé*.
- A typo corrected in passing: CAN's *Soon Over Bab**l**uma* → *Soon Over Bab**a**luma*.
- **Normalizing names exposes duplicates that decoration was hiding.** `El Sucu Tucu (Official Video)
  'The Visitor' Album` vs `El Sucu Tucu` looked like different tracks to any title comparison; after
  the strip, Matias Aguayo shows 4 identical *El Sucu Tucu* and 3 identical *Anenoa Pt. 2*. Juanes
  likewise shows 3 copies each of *A Dios Le Pido* and *Es Por Ti*. **Run a bulk normalize BEFORE any
  dedupe sweep**, or the sweep under-counts.

**Filed**
- **#775** — `services/title-clean.ts` (`cleanDisplayTitle`, #722) already encodes this rule and is
  correctly conservative, but it only runs at organize time (`library-organizer.ts:443`) and as the
  advisory `suggested` field (`candidate-sources.ts:173`). **Nothing applies it to existing rows**,
  and `remaster` is absent from its vocabulary. Proposes extending the vocabulary (year-like tokens
  must count as modifiers, or `(Remastered 2009)` fails to match) plus a dry-runnable bulk apply.
- **#776** — `fix_song_metadata` title writes **silently no-op on some `.opus` files**: returns
  `ok:true` / `applied` / `rescanned:true`, reverts on read-back. Live repro: all 9 tracks of Juanes
  *Un Día Normal (20th Anniversary)*. NOT a blanket opus failure — the same field succeeded on the
  flag #14/#16 opus files the same day, so #765 works in general. The root hazard is that `applied`
  echoes the *request* rather than the verified result, which would make #775's bulk pass report a
  clean run while changing nothing.

**Remaining**: a few hundred `Remastered` song titles, dominated by the Beatles catalog. Best closed
by the #775 script rather than one `fix_song_metadata` call at a time — but that script needs #776
fixed first, or it cannot tell success from silent failure.

### Session 4f — flag #17 resolution + genre lane resumed under Sonnet 5

**Flag #17 resolved**: hid (not deleted) the 125-track Welsh-language Linguaphone course via
`set_album_classification(hidden: true)` — verified `hidden: true` on read-back. Evidence:
lesson-numbered filenames, Welsh section markers, 3 tracks already carrying a `Non-Music` genre tag
from a prior pass. Not a delete — a language course is real content, just not library music.

**Genre lane, 19 more songs tagged** via `list_recent_songs(missingGenre: true)` +
web-search-per-artist, all `mode: 'replace'`:

- Spanish rock/pop cluster: Nacha Pop `Pop Rock`, Loquillo Y Los Trogloditas `Rock`, Pereza ×2
  `Alternative Rock`, Fran Perea `Pop Rock`, Melocos `Pop Rock`, El Chipirón de Granada
  `Copla;Flamenco`, Maesic `House` (features house originator Marshall Jefferson).
- Electronic long tail: Supernova `Tech House`, La Madone ×2 `Tech House`, Jombriel `Reggaeton`,
  Sante Sansone `Tech House`, Michael Bibi `House`, Prospa `House`, Quliano `Tech House`, Robbie
  Doherty `Deep Tech`, Nacho Scoppa `Tech House`, Jend `Tech House`, THE MASKING TAPES `House`,
  LondonGround `Deep Tech`, nocapz. `Tech House`, LEON (Italy) `Jackin House`, Seeing Double `Dance`,
  JACKSON (BRA) `House`, Josh Burnett (UK) `Tech House`, Marian (BR) `Tech House;Latin Tech`.

**Untagged, no usable evidence**: Shadi *Take Control*, Miralles *Trapping* — joins the existing
"generic name + single-song album" stragglers list (no sibling context, no release to look up).

**genres.missing**: 616 → ~597 (health snapshot mid-batch read 603 before this tick's last 5 landed).

### Session 4g — genre lane continued

12 more tagged, same `list_recent_songs` + web-search + `replace` pattern:
Ramon Bedoya ×2 `Tech House(;Latin Tech)`, Omari `Deep Tech`, Souler (ES) `Deep Tech`, MichaelBM
`Tech House;Latin Tech`, Michele Tiberio `Deep Tech`, SEBS `Tech House`, Joe Vanditti ×2 `House`,
Moxy Edits `Tech House`, Jezu (US) `Tech House`.

New unresolvable stragglers (same "generic name + single-song album" shape as Alfonso/Banzai/Ennio):
Rick Silva *the Rhythm Killa*, Noah Scannell *Lose My Breath*.

### Session 4h — genre lane continued, Latin American cluster + cron switch

Owner switched the loop driver mid-session: dynamic `ScheduleWakeup` self-pacing replaced by a fixed
`CronCreate` job (`f90464f1`, every 10 minutes) — same "continue" prompt, session-only, 7-day
auto-expiry.

11 tagged, same `list_recent_songs` + web-search + `replace` pattern — a Latin American cluster this
time, not electronic:
Vassilis Saleas *Orama* (Vangelis covers) `New Age`, Los Sultanes `Cumbia`, Los Delfines `Cumbia`,
Volcán `Cumbia`, Los Fatales `Cumbia`, Katunga `Cumbia`, Tomi Lago `Tango`, Joe Luciano `Dance`,
Lázaro Caballero ×3 `Chamamé` (Formosa/Corrientes chamamé singer, confirmed via es.wikipedia).

Skipped, insufficient/ambiguous evidence: Manuel Galán *Fronterizo*, Independent Lemon *Fiesta*
(genre claim rested on a thin single-source Beatport artist page), Las Sabrosas Zarigüellas, La
Batucada Murguera *Mueve tu cucu* (one source called it "Pop", but a murga/batucada act singing Pop
seemed like a mislabel worth not propagating without a second source).

### Session 4i — genre lane continued, Argentine folclore/NOA cluster

13 tagged, same `list_recent_songs` + web-search + `replace` pattern — a rich Argentine
folclore/norteño cluster:
Los Tekis `Folclore` (Jujuy folklore/carnaval fusion), Opus *Live Is Life* `Pop Rock` (Austrian
80s band — file mismatch: landed on an "Oktoberfest 2019" comp), Los Cadiz `Cumbia` (Cumbia
Santafesina), Los Del Suquía `Folclore` (Córdoba zamba ensemble since 1959), Teresa Parodi `Chamamé`,
Los Cantores De Quilla Huasi `Folclore` (est. 1953, zamba/cueca/chacarera/chamamé), La Cantada
`Carnavalito` (Jujuy), Los De Salta `Folclore` (zamba salteña specialists since 1958), Los Huayra
`Carnavalito` (Salta), Perro Primo `RKT` (cumbia 420/RKT originator), Huguito Flores el Super
`Cumbia` (cumbia santiagueña), La Base `Cumbia` (cumbia villera, "cumbia base" style), Ramiro y su
banda `Cumbia`.

### Session 4j — genre lane continued, cumbia-heavy cluster

13 tagged, same pattern: Los Palmeras `Cumbia` (cumbia santafesina pioneers since 1969), Lauty Gram
`RKT`, Santaferia `Cumbia` (Chilean "cumbia casera"), Koli Arce `Cumbia` (ex-Quinteto Imperial),
Juan Quin y Dago `Cumbia`, Migrantes ×3 `Cumbia` (cumbia-pop-reggaeton fusion), Los del Fuego
`Cumbia` (cumbia santafesina since 1984), Mc Caco `Cumbia`, Roberto Moron `Cumbia`, Onda Sabanera
`Cumbia`, La Joaqui `Trap`, aLee DJ *Soy Hincha de la Selección (Metal Cover)* `Metal` (self-declared
in the title).

Skipped: Joaquín Da Rosa *El Traje del PSG* — a viral hit whose own genre was unclear from sources
(trap/pop-adjacent); only fan-made remixes were confirmed cumbia, which isn't evidence for the
original.

### Session 4k — genre lane continued, more cumbia + genre diversity

14 tagged: Los Grosos ×4 `Cumbia` (Argentina's first band of short-statured performers, cumbia
tropical), Karina "La Princesita" `Cumbia` (romantic cumbia), Los Chicos de la Vía `Cumbia`,
Q' Lokura `Cumbia`, Ytthamar Tropicália & Paulo Axé `Samba Reggae` (Bahia, Afro-Brazilian), La
Repandilla `Cumbia` (cumbia villera, same "cumbia base" style as La Base), Mc Caco `Cumbia`, La
Joaqui `Trap`, Papichamp `Reggaeton`, Zhamira `Latin Pop` (bolero/merengue/Latin-soul fusion).

Joaquín Da Rosa *El Traje del PSG* reappeared in this batch's window — still skipped, same reason as
session 4j.

### Session 4l — genre lane continued, mainstream Latin urban + more cumbia villera

15 tagged: LIT killah `Latin Trap`, ZECCA `Latin Pop`, LUDMILLA `Funk Carioca` (Brazilian, feat.
Latto/Emilia), Pala Ancha `Cumbia` (cumbia villera, "cumbia callejera" originator), Los Dragones
`Cumbia` ("Kings of Southern Cumbia", Puerto Madryn), La Fase Buk `Cumbia` (Uruguayan), La Champions
Liga `Cumbia`, La Piedra Urbana `Cumbia`, The La Planta `Cumbia` (Uruguayan), Migrantes `Cumbia`,
Supermerk2 `Cumbia` (cumbia villera since 2003), La Base `Cumbia`, Ke Personajes `Cumbia`, OKY
`RKT` (feat. L-Gante, the genre's originator), Perro Primo `RKT` (consistent with earlier tag).

genres.missing dropping steadily across sessions 4f–4l (~140 songs tagged total this pass).

### Session 4m — genre lane continued, fresh ingest: Catalan rumba cluster

A live ingest landed mid-tick (`get_library_health` totals jumped songs 16575→16769,
albums 5235→5429, artists 2999→3090). Per the standing "pause destructive work during an ingest"
rule, kept to additive genre tagging only — no dedupe/delete this tick.

11 tagged, a Rumba Catalana / flamenco cluster (Barcelona's Romani-community genre, pioneered by
Peret in the 1950s-60s): Malakaton `Rumba Catalana`, Banannabeach `Rumba Catalana`, Dumingu `Rumba
Catalana`, Peret `Rumba Catalana` (the genre's originator, landing on his own catalog), Taburete
`Pop`, Los Rebujitos `Flamenco Pop`, Sabor De Gracia `Rumba Catalana` (Barcelona band since 1994),
ROSALÍA `New Flamenco` (a "Cap." single in the *Pienso en tu mirá* / *El mal querer* style), Decai
`Rumba Catalana` (pioneered flamenco-rumba+reggaeton fusion), El Cigarrito de Después `Rumba
Catalana`, El Sebas de la Calle `Rumba Catalana`.

Skipped: El Quinto Carajillo (no evidence found), Las Karamba ×2 (no evidence found), Figa Flawas
(confirmed genre-blending act with no single clear primary — pop/urban/reggaeton/rumba/drill all
cited, tagging any one would be a guess).

### Session 4n — genre lane continued

5 tagged: El Chipirón de Granada `Copla;Flamenco` (consistent repeat tag), Supernova `Tech House`,
VITO (UK) `Tech House`, Michael Bibi `House`, Robbie Doherty `Deep Tech` — all repeat artists from
earlier sessions, consistent genres reapplied to new tracks.

Skipped: Albert Pla — his own biography material explicitly says his work resists genre
classification ("muy difícil de clasificar dentro de ningún género musical establecido"); tagging
anything would be a guess against the artist's own stated identity. Remaining 8 in this window are
the long-documented unresolvable stragglers (Pesho & Dave Bo, Wrytzy, FIA, Ivy, Kilometro1, Fat Papi,
Marcello Marchitto, Oravla Ziur, Shadi) — no new evidence surfaced.

### Session 4o — genre lane continued

10 tagged: Ramoss `House`, Voltech `Tech House`, Rawfox `Tech House`, Max Dean `Tech House` (UK #19
chart hit), Hedge `Deep House`, Saraga `House`, Josh Burnett (UK) `Tech House` (2nd track, consistent
with earlier tag), Marian (BR) `Tech House;Latin Tech` (2nd track, consistent), LEON (Italy)
`Jackin House` (2nd track, consistent), Ramon Bedoya `Tech House;Latin Tech` (3rd track, consistent).

Skipped: JS Alpha *Crashout* (no usable evidence). Ennio, Rick Silva, Noah Scannell reappeared in
this window — still no evidence, remain on the unresolvable-stragglers list.

### Session 4p — genre lane continued

11 tagged: Vassilis Saleas ×2 `New Age` (repeat), Piano in a Living Room `New Age` (Vienna, piano
covers of Vangelis — matches Saleas' own catalog thematically), Tomi Lago ×3 `Tango` (repeat),
Miranda! `Pop` (iconic Argentine electropop duo), Jorge Rojas `Folclore` (ex-Los Nocheros, solo
folclore/romántica), Los Palmareños `Cumbia` (cumbia santafesina roots, self-described as
folklore/rock/cumbia hybrid — tagged on the dominant thread), Sele Vera Y Los Pampas `Cumbia`, Marama
`Cumbia Pop` (Uruguayan cumbia-pop pioneers, distinct enough from plain Cumbia to warrant its own
tag).

Independent Lemon, Las Sabrosas Zarigüellas, La Batucada Murguera, Manuel Galán reappeared — still
skipped, no new evidence since sessions 4h/4m.

### Session 4q — genre lane continued, WebSearch budget exhausted mid-tick

13 tagged: Juliana `Bolero` (Colombian, *Mar Adentro* album), TINI `Latin Pop`, RENEE `Indie Pop`
(Monterrey), Milo j `Trap Pop`, LIT killah `Latin Trap` (2nd track, consistent), Rels B `Latin Hip
Hop`, ROLE MODEL `Alt Pop` (Tucker Pillsbury, US Billboard #1), Sonido Basico `Cumbia` (cumbia
villera, ex-La Base members), La Base ×2 `Cumbia` (consistent), Q' Lokura `Cumbia` (consistent),
Perro Primo `RKT` (consistent), The La Planta `Cumbia` (consistent).

**Session hit its WebSearch budget (200/200 calls)** mid-tick — two artists (Roman El Original, Nuke)
went unresearched and were left untagged rather than guessed. This caps how much further evidence-
gathering this session can do; future ticks should expect the same limit unless it resets, and
should prioritize repeat-artist tags (no search needed) over fresh unknowns.

### Session 4r — WebSearch budget exhausted, minimal tick

Only one song taggable without fresh evidence this tick: Sabor De Gracia `Rumba Catalana` (repeat
artist, tag established in session 4m). The rest of the current `list_recent_songs` window
(María Ruiz, Maison Bélier ×3, Montse Cortés, La Sra. Tomasa, Maruja Limón ×2, Mayte Martin) sits in
the same landedAt cluster as the confirmed Catalan rumba/flamenco ingest from session 4m and is
very likely the same genre family — but cluster proximity is not evidence, and the standing
"search, don't guess" policy holds even under budget pressure. Left untagged.

Checked `list_review_flags` instead (no search budget needed): both open flags (#15 DJ Nu-Sky
identity, #18 Green Velvet collaborator credits) are unchanged from their prior write-ups — both
correctly still deferred to the owner, nothing actionable without a decision only they can make.

**Session WebSearch budget remains exhausted for the rest of this session.** Genre-tagging progress
from here will be limited to repeat artists already researched this session; fresh-artist tagging is
paused until the budget resets (a new session) or `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` is
raised.

### Session 4s — still WebSearch-limited, repeat artists only

3 tagged, all repeats with evidence from earlier this session: Marian (BR) `Tech House;Latin Tech`,
Piano in a Living Room ×2 `New Age` (film-score piano covers, same pattern as their Vangelis work).

Fresh unresearched artists in this window (ICE THOMPSON, Tony Amatore, Void, Mellizos, Mochakk,
OldChild, Kieran San Jose, Memphis La Blusera) left untagged — no WebSearch budget to evidence them.
Genre-tagging throughput is now bottlenecked on the exhausted session search budget; each tick nets
only the handful of repeat-artist tracks still landing.

### Session 4t — still WebSearch-limited, repeat artists only

4 tagged, all repeats: Jorge Rojas `Folclore`, Ramiro y su banda `Cumbia`, Prospa `House`, Maesic
`House` (same track title as session 4e's tag, landed under a fresh songId — likely a re-ingest
duplicate row, consistent tag applied regardless).

Fresh unresearched artists this window (La Banda De Lechuga, Los Cantores del Alba, Roberto Rimoldi
Fraga, Leader Music, Roman El Original, Nuke, PAWSA, cassö, Niklas Dee, Morgan Seatree, Victor
Mendivil, Los Dareyes De La Sierra, Rawayana, Ya Ice Dilan, Jetta) left untagged — no search budget.
Joaquín Da Rosa reappeared, still skipped per session 4j reasoning.

### Session 4u — loop stopped, WebSearch budget floor reached

1 tagged (Maesic `House`, another re-ingested copy of the same track). Every other artist in this
window is unresearched and fresh — yield has dropped from 15-19 tags/tick earlier in the session to
1, a clear floor. Continuing the 10-minute cron tick past this point would just spin on empty
windows until the session's WebSearch budget resets.

**Cron job `f90464f1` stopped here.** Session totals for the genre lane (sessions 4f-4u): ~150 songs
tagged, all `mode: 'replace'` with web-sourced evidence, spanning cumbia, chamamé, tango, folclore,
carnavalito, rumba catalana, RKT, trap, reggaeton, tech house/deep house/house, samba reggae, funk
carioca, bolero, and more. `genres.missing` fell from 616 to roughly 520 over the session (some
regrowth from concurrent live ingests). Remaining unresolvable stragglers (Alfonso, Banzai, Ennio,
Rick Silva, Noah Scannell, FIA, Ivy, Kilometro1, Fat Papi, Wrytzy, Shadi, Marcello Marchitto, Oravla
Ziur, Flash ×2, Miralles, JS Alpha) share one shape: generic artist name + single-song album, no
sibling context, no findable release to look up — genuinely closed off to web search, not a budget
artifact.

Next session: resume `list_recent_songs(missingGenre: true)` from wherever the backlog stands; the
Catalan rumba/flamenco cluster from session 4m (María Ruiz, Maison Bélier, Montse Cortés, La Sra.
Tomasa, Maruja Limón, Mayte Martin) is a good first target — high-confidence genre family, just
needs per-artist confirmation searches.

### Session 4v — resumed after compaction, WebSearch budget still exhausted

Confirmed the WebSearch budget (200/200) did NOT reset — this is a continuation of the same
underlying session despite the context compaction/summary boundary, not a fresh one. All 10 search
attempts this tick were refused by the harness.

5 tagged from repeat artists with prior evidence: Pereza ×2 `Alternative Rock`, Fran Perea
`Pop Rock`, El Chipirón de Granada `Copla;Flamenco`, Melocos `Pop Rock` — all re-landed copies of
tracks already tagged in session 4e.

A large fresh Catalan cluster landed (Joan Garriga i el Mariatxi galàctic, Els Catarres, Los
Manolos, Remendaos, Arrels De Gràcia, Cesk Freixas, Maruja Limón, SanIsidro, Alma de Boquerón,
ÉSSERS, Muchacho, Lluki Valverde, Complikaos, La Mare del Tanu, La Cabra Mecanica) — almost
certainly the same rumba catalana / Catalan pop-rock family as sessions 4m/4r, but left entirely
untagged: no budget to confirm per-artist, and cluster proximity is still not evidence.

**Recommendation for the owner**: raise `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` to unblock this
backlog, since it is now the sole bottleneck — the curation methodology and worklist are both ready
to go the moment search is available again.

### Session 5 (2026-08-28) — zero-search lane + identify_song on an open flag

Baseline: `genres.missing` 462, `flags.open` 2 (id 15 DJ Nu-Sky identity, id 18 Green Velvet
*Unshakable* under-credited collaborators). No WebSearch used this session.

**Genre, free lane only**: checked `get_artist` for every multi-album artist in the fresh
`list_recent_songs(missingGenre: true)` window. Sibling album genres were all null (no
propagation available), but four artists were confident from domain knowledge with no search
needed: Nate Smith (jazz drummer, `KINFOLK`) and Joel Ross (jazz vibraphonist, `KingMaker`) →
`Jazz`; Tangents (Australian jazz/electronic duo, `Timeslips & Chimeras`) → `Jazz`; Marsh
(Anjunabeats trance/prog-house producer, US-origin MBID confirmed) → `Progressive House`. 8 songs
tagged `mode: 'replace'`, all read back via `get_album_tracks` and confirmed persisted.
`genres.missing` 462 → 454.

**Flag 15 resolved** using `identify_song` (fpcalc/AcoustID) rather than web search: the flagged
"Hold On" / DJ Nu-Sky track fingerprinted as a genuine DJ Nu-Sky recording (score 0.96, MB
recordingId, MB title "Track 13" — a generic mix-CD rip), settling the flag's open identity
question in favor of the Latin mix-CD act. Corrected genre `House` → `Latin` (replace), resolved
the flag with the evidence cited.

**Flag 18 investigated further, left open**: ran `identify_song` on the 5 remaining
"Relief Records"-labeled-as-genre tracks on Green Velvet's *Unshakable* (Beatport 403s blocked
this last session). All 5 fingerprinted cleanly as genuine Green Velvet recordings matching their
existing titles — but `identify_song` carries no genre and no collaborator-credit data by design,
so it couldn't resolve either open question on this flag (correct genre, or the 10 missing
collaborator credits). The album's other 8 tracks split evenly Techno/Tech House, so sibling
propagation doesn't clear the bar either. No write made; flag stands as before, still needing a
manual Beatport/Discogs per-track pass.

Final: `genres.missing` 454, `flags.open` 1. Net this session: 9 songs fixed (8 genre + 1 flag
identity/genre correction), 0 searches spent, 1 flag closed. Confirms the skill's zero-search-lane
guidance holds even mid-backlog — `get_artist`/domain knowledge and `identify_song` cleared real
work with no search budget at all.

### Session 5d (`/loop 5m`, same day) — paging `list_recent_songs(missingGenre:true)` by offset

Continued the zero-search approach as a 5-minute cron loop, each tick reading a fresh page and
tagging every artist recognizable from domain knowledge, still 0 WebSearch calls. `genres.missing`
454 → 397 (tick 1, 25 songs across Jazz artists — Nate Smith, Joel Ross, Tangents, Henry Solomon,
Ian Carr, Jon Gordon Quintet, Ray Gallon, Vels Trio, Valentino Jazz Bazar, Polar Bear — plus
Progressive House/Nuevo Tango/Jazz-Rock/Tropicália/Pop-Rock/Hip-Hop/Post-Punk singles) → 384
(tick 2, 33 songs: full Juana la Loca `Punk Rock`, full Matias Aguayo `Minimal House`, WhoMadeWho
`Nu-Disco`, Miranda! `Pop`, Los Tekis `Folklore`). All writes read back via `get_album_tracks`.

**Self-caught sibling-agreement violation**: tagged 2 Miranda! singles `Synth-Pop` from genre
knowledge (accurate stylistically) while the album's other 8 tagged tracks already said `Pop`
6-to-0. The skill's own rule — propagate only where ≥2 tagged siblings *agree* — says match the
established majority, not substitute a more "correct" label; a more precise genre that disagrees
with the album's consensus is still the violation, not an improvement. Caught it on the next
read-back and retagged both (plus 2 more landing in the same tick) to `Pop`. Same pattern hit
WhoMadeWho: initially guessed `Indie Dance` for 4 tracks landing before 9 sibling tracks were
visible on the same page, corrected to `Nu-Disco` once the album read showed the majority.
**Lesson: read the full album's existing genre spread before tagging a genre-less track on it —
even a confident guess should defer to an established in-album majority.**

Skipped without tagging (per policy, `list_recent_songs` continuing to surface the Linguaphone
Welsh-course non-music rows from flag #17 and several generic-name/generic-title singles) —
left untouched, not guessed.

Running total this session: 462 → 384 (78 songs fixed), 0 searches, 1 flag closed. Loop continues
via `CronCreate` job `b6e0dbc6` (every 5 min, session-only, 7-day auto-expiry).

**Loop continued, 3 more ticks, then stopped deliberately.** 384 → 373 → 369, mostly finishing out
partially-tagged albums as later pages surfaced their remaining tracks (rest of Juana la Loca's two
albums, rest of Matias Aguayo's *The visitor CD2* and *NA*, WhoMadeWho's *Green Versions*, Los
Tekis, Miranda!) — all `Punk Rock` / `Minimal House` / `Nu-Disco` / `Folklore` / `Pop` respectively,
each read back confirmed. **Stopped the loop deliberately at 369**: the remaining backlog is now
dominated by the Linguaphone Welsh-course non-music block (flag #17, ~125 rows, permanently
unfixable by genre-tagging) and singleton generic-named regional Latin acts (Trace (UZ), La Fiesta,
Mambru, La Barra, Sombras, Nestor En Bloque, Paulina, S.B.S., Los Nota Lokos, Los Bam Band, Super
Mer Ka 2, Tu Voz, Siren, Tiburon Valdez) with no sibling context and no name I can resolve from
domain knowledge alone — exactly the "genuinely closed off to web search" residue shape documented
in session 5c. Continuing the zero-search loop past this point would burn ticks for near-zero yield;
the productive next step is a `list_recent_songs(missingGenre:true)` pass **with** WebSearch
available, not more zero-search ticks.

Session total: 462 → 369 (93 songs fixed across ~6 ticks), 0 WebSearch calls, 1 review flag closed
via `identify_song`. `CronCreate` job `b6e0dbc6` cancelled.

### Session 5e (2026-08-29) — Linguaphone Welsh-course album deleted, owner's call

Owner asked to finally remove the Linguaphone "Cwrs Cymraeg - Recordings" album (flag #17's
subject, sitting untouched every session since it surfaced — 125 tracks of Welsh-language-course
dialogue, permanent head of both the coverless and year-less worklists, `hidden: true` already).
Confirmed via `get_album_tracks` before deleting (still 125 tracks, all Welsh dialogue, a few
already carrying `Non-Music`/`Children's` genre tags from an earlier attempt), then
`delete_album(confirm: true)` → `{"deletedCount":125,"failedCount":0}`, verified by a follow-up
`search_library("Linguaphone")` returning zero rows and `get_library_health` showing songs
16747→16622 (−125), artists 3089→3088, albums 5426→5425. **Side effect**: `genres.missing` dropped
369→248 in one step (121 of the 125 tracks were genre-null) — a reminder that a stale unresolvable
backlog item can be worth more as a deletion than as a tagging target. Flag #17 was not in the open
list any more (only #18 remains) — already closed in an earlier session, nothing further to do.

### Session 6 (2026-08-30) — a false "the tool does not exist" finding, and the album under it

Baseline 255 genre-less (378 on 08-28; the 08-29 Linguaphone delete accounts for most of the drop).

**The pass first concluded that `set_song_genre` does not exist and that genre curation is
impossible over MCP. That was wrong, and the way it went wrong is the useful part.** MCP tools
arrive deferred: a name is listed, but the schema must be fetched with `ToolSearch` before the tool
is callable. The opening `ToolSearch` selected ten tools and simply omitted `set_song_genre`. Not
finding it among the loaded ten, the pass read its own incomplete selection as the library's
capability surface, checked `fix_song_metadata` (which has no `genre` param — correctly, it is a
different tool), and wrote up a "critical structural gap" in this file and in memory. A second
`ToolSearch` produced the tool immediately, with exactly the `{songId, genre, mode}` signature the
skill documents. Eleven `mode: 'replace'` writes then went through, every one `tagWritten: true`
and confirmed by read-back.

This is the skill's own "never conclude absence from an empty read" rule (written about the
pre-#778 wrong-key trap) reappearing one layer down — **the same inference, made about the tool
list rather than about a query result**. It is worth its own line because the tell is different: a
wrong argument key now errors loudly, but an unfetched deferred tool is *silently* absent, and the
absence looks exactly like a missing feature. **Before reporting any capability as missing,
re-run `ToolSearch` for it by name.**

Cost of the wrong turn: five `fix_song_metadata` calls issued as a substitute for the genre write,
setting `album` to the value each song already had. Four returned `ok:true` as no-ops; the fifth was
correctly *refused* — `{"error":"Tag write did not persist", requested "Vuelo Nocturno", actual
"Vuelo nocturno"}` — the file's tag differs only in case and the post-#760 verify-on-write guard
caught it rather than reporting success. Nothing was corrupted, but five prod audio files were
rewritten and rescanned for no benefit. **A no-op retag is not free, and reaching for the nearest
tool that accepts the id is not a workaround for the right tool.**

#### The album the triage missed

The pass reported Umoja's *Vuelo Nocturno* as "3 genre-less songs, apply Afrobeat" from
`list_recent_songs` alone. `get_album_tracks` shows 12 rows: **six** genre-less, and five
duplicate pairs/triples (`Rabia` twice as FLAC, `Vuelo Nocturno` as two FLACs plus an opus,
`Manicumbi`/`Muerto Mi Abuelo`/`La Piragua` each FLAC + opus). Three opus copies also carried junk
genres — `Music` on one, `Electro` on two — against a FLAC-side majority of `Afrobeat` that matches
the artist- and album-level genre.

`list_recent_songs(missingGenre:true)` pages by `landedAt`, so it shows the *arrivals*, never the
album's shape. Reading the album is what turns "3 songs need a tag" into "12 rows, 6 untagged, 3
mistagged, 5 duplicate sets". Session 5d's lesson was to read the album before choosing a genre;
this extends it — **read the album before believing the worklist's count.**

#### Applied — 11 songs, all `mode: 'replace'`, all read back

| Album | Songs | Genre | Evidence |
| --- | --- | --- | --- |
| Rosalía — *LUX* | 2 (`Mundo Nuevo`, `Dios Es Un Stalker`, both opus) | `Art Pop` | 18 of 20 siblings already `Art Pop`; both are opus duplicates of FLACs that carry it |
| Umoja — *Vuelo Nocturno* | 6 genre-less | `Afrobeat` | 3 tagged FLAC siblings agree; matches artist- and album-level genre |
| Umoja — *Vuelo Nocturno* | 3 mistagged (`Music` ×1, `Electro` ×2) | `Afrobeat` | in-album majority 9–3 after the six; `Music` is not a genre |

`genres.missing` 255 → 246. Total songs moved 17522 → 17523 mid-pass (a live arrival), so the
report's own delta is not a clean subtraction of the writes — the read-back per song is the
authoritative check, not the metric.

#### Audio identity probes

`identify_song` on three junk-named rows: the `Unknown Artist` Radiohead *Pablo Honey* row returned
`undecodable` (`Could not find any audio stream` — a **broken file**, a triage signal rather than a
metadata answer); Pesho & Dave Bo's *Lemon Tree* matched at 0.953 with no MusicBrainz
`recordingId`; Wrytzy's *I Will Find The Hood* returned a genuine `no-match`.

#### Left open, deliberately

- **The Umoja duplicate sets** — not deleted. Dedupe is destructive, `songs` moved during the pass
  (a live arrival), and the skill's mid-ingest rule says suspend destructive work. Needs an owner
  ruling and a `recordingId` comparison first.
- **Flag #18 (Green Velvet, *Unshakable*)** — still open, unchanged.

#### Then searched — the lane session 5d stopped at

Session 5d ended its zero-search loop noting that "the productive next step is a
`list_recent_songs(missingGenre:true)` pass **with** WebSearch available, not more zero-search
ticks." That pass ran here: **eight searches, one per artist, covering 13 songs** — the whole
2026-08-27 Catalan/Spanish ingest wave, which arrived in a single tick.

| Artist | Songs | Genre | Basis |
| --- | --- | --- | --- |
| Maruja Limón | 2 | `Rumba Catalana` | a sibling album already carried it; search confirms "next-gen rumba catalana", Barcelona sextet |
| Maison Bélier | 3 | `Rumba Catalana` | Catalan duo (ex-Ojos de Brujo); repertoire straddles rumba and flamenco pop |
| Las Karamba | 3 | `Salsa` | Barcelona sextet with Cuban/Venezuelan members; son, cha-cha-chá, timba |
| Figa Flawas | 1 | `Reggaeton` | Catalan urban duo from Valls |
| Montse Cortés | 1 | `Rumba Flamenca` | cantaora; track titled "(Rumba)", from *La Rosa Blanca* (2004) |
| Mayte Martín | 1 | `Flamenco` | Barcelona cantaora, *Al Cantar a Manuel* (2009) |
| La Sra. Tomasa | 1 | `Latin Fusion` | Barcelona; Afro-Cuban rhythms over electronic bases |
| María Ruiz | 1 | `Cantautor` | word/poetry-forward; her collaborators are cantautores |

Plus two off the new list head, both the "distinctive proper noun" shape the skill says actually
resolves: **Los Chichos** → `Rumba Flamenca` (they pioneered the genre; RateYourMusic lists the
*Quiero ser libre* single as exactly that) and **Juan Arvizu** → `Bolero` (Mexican lyric tenor;
"Santa" is an Agustín Lara composition).

**The wave was not one genre, and that is the finding.** Eight Catalan/Spanish artists landing in
one tick invited a single label — the searches split them across five, and Las Karamba sit
geographically among rumba-catalana acts while playing Cuban salsa. The skill's rule that a
coherent ingest wave carries one judgment is about *arrival*, not sound: **a wave justifies
amortizing one search per artist, never sharing one artist's answer across the wave.**

#### Session total

`genres.missing` **255 → 231** across the pass (26 writes: 23 genre-less filled, 3 mistags
replaced; the extra point of movement is a live arrival mid-pass). Every write `mode: 'replace'`
and confirmed by read-back.

The list head is now the residue in its documented shape — a corrupt file (`undecodable`), a
singleton with no MBID, a generic producer name, and an AcoustID `no-match`. Nothing there is a
search away, and low yield past this point is the expected state, not neglect.

#### Umoja dedupe — owner-approved, evidence-first

The 12-row *Vuelo Nocturno* album resolved to **6 real tracks held as 12 files** — two rips of the
same release. `identify_song` on all 11 duplicate candidates: every set shares an `acoustId`
(proof of same recording), with `recordingId` corroborating on three of the five.

| Track | Held | Verdict | Kept |
| --- | --- | --- | --- |
| 1 Manicumbi | flac 685 / opus 211 | same acoustId + recordingId | flac |
| 2 Muerto Mi Abuelo | flac 733 / opus 204 | same acoustId | flac |
| 3 Flujo suave | flac 613 **only** | no duplicate | flac |
| 4 Rabia | flac 655 / flac 637 | same acoustId + recordingId | flac 655 |
| 5 La Piragua | flac 689 / opus 148 | same acoustId + recordingId | flac |
| 6 Vuelo Nocturno | flac 756 / flac 732 / opus 210 | same acoustId ×3 | flac 756 |

**Track 3 is the skill's warning made real.** *Flujo suave* exists only in the second rip, so
deleting that rip wholesale — the obvious move, since the first rip looked more complete — would
have silently lost a track. Dedupe is per-file, never per-rip.

Also worth stating plainly: **between two FLACs, bitrate is not a quality signal.** Both are
lossless; the difference reflects encoder settings on the same audio. Bitrate was used only as a
harmless tiebreaker, not as evidence one copy was better.

Result: 12 → 7 files, songs 17523 → 17518, lossless 754 → 752. **One deletion was refused by the
harness permission classifier** (the track-1 opus, `0cebfc72`) and is left in place — the album is
6 FLAC plus that one straggler until an owner removes it.

**#774 did not reproduce.** The album's `song_count` read 7 against 7 actual rows immediately after
five single-song deletes; the stale-aggregate bug filed in the 08-27 pass did not bite here. Worth
a confirmation before the issue is closed on this evidence alone.

#### Flag #18 (Green Velvet, *Unshakable*) — worked, not closed; filed #817

The flag said three duplicate fragment albums existed. There are **seven**, and each is a 1-track
"Unshakable" single whose FLAC bitrate matches its main-album counterpart *exactly* — duplicate rips
that still carry the collaborator credit the main album lost. **The fragments are themselves the
evidence**, so seven of the thirteen credits were recoverable with no search at all: Riva Starr,
Gary Beck, Nathan Barato, Craig Williams, Harvard Bass, Saso Recyd, Phil Kieran.

Four more came from the web (Zcarab, wAFF, Oliver Dollar, and *Leave My Body* being Green Velvet
**solo** — Sonny Fodera is the remixer, not a collaborator). That is 12 of 13 mapped; only
*Check U Out* is unconfirmed, and DJ Gant-Man being the one unused name on the credits is inference,
not evidence.

**None of it could be applied.** All 13 `fix_song_metadata` artist writes were *refused*:
`{"error":"Tag write did not persist", requested "Green Velvet, Riva Starr", actual "Green Velvet"}`,
persistent across a full re-read. The post-#760 guard did its job — it refused instead of returning
a false `ok:true`. Something upstream pins the field; `set_song_genre` on the *same tracks in the
same session* wrote and persisted fine, so it is specific to `artist` on this album. Filed as
**#817**, with the `library_metadata_overrides` explanation written down explicitly as a
*hypothesis*: it could not be verified from a refiner MCP session, and #710 and #762 both shipped
with filed diagnoses that turned out to be wrong.

**The flag's recommendation reversed, and that is the finding worth carrying.** It originally said
to delete the duplicate fragments after retagging. Since the retag is blocked, the fragments are
currently the library's **only** carrier of 7 of the 13 credits — deleting them now would take the
library from 7/13 to 0/13, causing precisely the loss the flag was raised to prevent. **A cleanup
step that is correct in the intended order becomes destructive when the step before it fails.**

Genre: label-as-genre rows down 5 → 3 (*Move Your Body*, *Leave My Body* → `Tech House`, both from
Beatport, both read back). *Dance To My Beat*, *In Your Spirit* and *Check U Out* still read the
literal label `Relief Records`; four searches found no per-track genre and they were **not** guessed
— Relief is documented as mixing Chicago/acid/ghetto house with harder techno, so defaulting them to
the album-dominant Tech House is genuinely risky, most of all on a possible DJ Gant-Man track. Worth
noting these three are **invisible to the genre worklist**, because a wrong genre still counts as a
genre — label pollution hides where a null would show.

Flag #18 left **open**, deliberately: the data question is answered, the write path is not.

#### #817 — the filed hypothesis was wrong; the verified cause is `resolveTags`

A read-only prod probe killed the `library_metadata_overrides` theory outright: 574 rows, **zero**
referencing this album. Writing it into the issue as an explicit hypothesis rather than a finding is
the only reason that cost nothing — #710 and #762 each shipped a filed diagnosis that was wrong, and
this would have been the third.

The real cause, in `library-scanner.ts:319-327`:

```js
const albumArtistIsVA = hasUsableValue(t.albumArtist) && isVariousArtists(t.albumArtist!);
if (albumArtistIsVA && hasUsableValue(t.artist)) { trackArtist = t.artist!; }
else { trackArtist = albumArtist; }   // per-track ARTIST tag discarded
```

**A track's own `ARTIST` tag is honoured only when `albumArtist` is literally "Various Artists".**
Everywhere else the tag is read and then overwritten with the album artist. The probe confirmed the
write itself succeeds — files are mode 644 owned by the container's own uid, and their mtime is the
exact minute of the attempts. So the write lands and the rescan discards it; the post-#760 guard
reports that correctly. It is a design limitation, not a bad row: **a collaboration-heavy album that
is not VA-tagged cannot express per-track credits at all.**

**A second self-correction in the same probe.** I had reported the `library_song_artists.role`
column as never populated outside tests. Wrong — I grepped `'featured'`, the *test* literal;
production emits **`'featuring'`** from `artist-split.ts:206`, and prod holds 9 real rows of it. The
dimension works, but only when the *resolved* artist string itself carries a `feat.`-style compound
for `splitArtists` to parse — and on a non-VA album that string is the albumArtist, so a collaborator
living only in the per-track tag can never reach it.

Two wrong claims in one issue, both caught by one read-only probe that took two minutes. **The
grep-for-the-wrong-literal failure is the same shape as the session's opening mistake: concluding
absence from a search that was never capable of finding the thing.**

#### Audit high-severity lane — `watermark_album` 3 → 1

The health report gives counts, not ids. Rather than re-implement `looksLikeSourceWatermark` in a
probe — which the prod-inspection doc warns will drift from shipped code — this used the documented
replay pattern: dump prod `library_albums`/`library_artists` to JSON, then run the **real** exported
predicate from `library-quality.ts` locally against it. It returned exactly 3, matching the health
report. **The denominator agreed rather than being asserted.**

All three were the #705 shape — junk metadata, real audio — and none was deletable:

| Album | Verdict |
| --- | --- |
| **Coolio — "Coolio.com"** (23 tracks, cover, visible) | **False positive.** `coolio.com` is the genuine title of Coolio's 2001 album. Filed as **#819**. |
| LOSERPOWER.ORG … VOLUMEN 8 — Nestor En Bloque (1 track) | Real cumbia villera song under a warez title → retagged *Mi Único Amor* (2005) |
| Most Wanted 80 Djs Chart … ElectronicFresh.com — Cassian (1 track) | Real track under a warez title → retagged *Laps* (2020, single) |

**The false positive is noise, not danger — and checking which mattered.** `watermark_album` is in
`DELETABLE_RULES`, so the first read looked like a data-loss risk on a real 23-track album. It is
not: `selectPollutionTargets` calls `albumHasRealTrackTitles` before adding anything to the delete
set, and Coolio's real titles route it to `protectedRealAudio`. **The #705 protection does exactly
its job.** #819 is filed for metric accuracy — a third of a high-severity bucket being false costs a
curator attention every pass — not for a phantom risk. Reading the guard before filing changed the
issue from "may delete a real album" to "inflates a count", which are very different asks.

**Both retags merged into albums that already existed**, and each surfaced a duplicate — the
"consolidating buckets surfaces duplicates" pattern from the 08-27 pass, reproduced twice in one
step. Both pairs proven same-recording by `acoustId` + `recordingId`, then the weaker copy deleted
(Cassian: kept the copy carrying the verified `House` genre; Nestor: kept 192 kbps over 128).

**Coolio dedupe — 23 → 14 files.** Nine pairs, each tagged `Hip Hop` in one rip and `Gangsta Rap` in
the other, all nine proven identical by `acoustId` **and** `recordingId`. Track 9 *"Life"* exists
**only** in the Gangsta Rap rip and tracks 1–4 only in the Hip Hop rip — neither rip is complete, so
per-rip deletion would have lost music either way. This is the second album in one session where
that held. Unlike the Umoja FLAC case, these are opus, so bitrate **is** a real quality signal; the
`Hip Hop` copy was higher in all nine. *"Life"* then moved to `Hip Hop` on the 13–1 in-album
majority.

`songCount` read 14 against 14 actual rows straight after nine deletes — **#774 did not reproduce a
second time.**

#### Chasing a 426-song delta — the orphan sweep catching up, not data loss

Total songs read 17523 → 17097 across two health calls, against the 11 files this pass deleted. That
looked alarming enough to record as unexplained. A read-only prod probe resolved it, and the answer
is the designed mechanism working:

- **`audit_log` shows exactly 16 `song.delete` entries in 24h** — 5 Umoja, 9 Coolio, 2 surfaced by
  the retags. Every one mine. **No unaudited deletion happened by any route.**
- `library_sync_state.last_full_sync_at` = 1788094287964, falling *between* the two health calls.
- The surviving rows are real: 0 of 40 random rows missing from disk; `landed_at IS NULL` = 0 and
  `hidden` = 0, so it is not a denominator shift either.
- `scan_cache` holds 1774 entries with no `library_songs` row, and **1281 of them already carry
  `orphaned_at`** — the mark→sweep-with-grace-period pruner, mid-cycle.

The largest orphan bucket is **125 rows under `Linguaphone/`, whose directory no longer exists on
disk** — the Welsh-course album the owner deleted on 08-29. That single fact validates the whole
reading: the sweep is retiring rows for deletions made in *earlier* sessions, which is exactly what
a grace period defers. The 426 is accumulated catch-up, not this pass's doing.

**Residual worth a look, not an issue:** ~493 of those 1774 are *not* marked `orphaned_at`, and a
300-row sample found 282 files still present on disk. Concentrated in `Andrés Calamaro` (98),
`Various Artists` (94), `Laura Pausini` (93), `Radiohead` (44). That may be entirely legitimate —
canonical-tracklist admission filtering, or parse failures — but it is on-disk audio with no library
row, so it is worth someone confirming deliberately. **Not filed as a bug**: the evidence points at
designed behaviour, and filing a data-loss issue on this reading would have been the third wrong
diagnosis of the session.

**The lesson is about the alarm, not the number.** "426 rows vanished" and "a deferred sweep
retired rows for music deleted last week" are the same measurement. The difference was four probes,
and the decisive one was the cheapest: counting audited deletes.

### Session 7 (2026-08-31) — a flag that fixed itself, and the durability mechanism that is not durable

**Baseline** (prod, after the v0.5.52/v0.5.53 deploys): 3,185 artists / 5,739 albums / 17,622 songs;
audit high 68; genres.missing 228; 1 open flag (#18); misSplitAlbums 9.

**Final**: 3,177 artists / 5,732 albums / 17,495 songs; audit high 67; genres.missing 228; **0 open
flags**; misSplitAlbums 8.

| dimension | before | after | delta |
| --- | ---: | ---: | ---: |
| open review flags | 1 | 0 | −1 |
| missplit albums | 9 | 8 | −1 |
| albums | 5,739 | 5,732 | −7 |
| artists | 3,185 | 3,177 | −8 |
| audit high | 68 | 67 | −1 |
| years missing | 194 | 193 | −1 |
| genres.missing | 228 | 228 | 0 |

#### The +525 songs at baseline were not an ingest

`list_recent_songs` showed 30 rows sharing **one identical `landedAt`**, all of them long-owned
catalogue (*Pescado 2*, *Freaky Styley*, *El Mal Querer*). Song ids are `sha1(path)`, so a
reorganize re-mints every id and the whole library reads as "just landed". **`landedAt` clustering,
not row count, is the honest test for "did something arrive"** — and the answer decided whether
destructive work was safe to start.

#### Flag #18 was resolved by a deploy, not by curation

#817 shipped as `782c5e30 fix(scanner): honour the per-track ARTIST tag, pinning ownership to the
album` (v0.5.52). Re-reading the album afterwards, **all 13 Green Velvet collaborator credits were
present, with zero writes from this session.**

Three things worth keeping:

- The flag's premise — *"the fragments are the library's ONLY carrier of 7 of the 13 credits"* — was
  drawn from a **DB read**, and the DB was the lossy layer. The file tags had every credit all
  along; the scanner was discarding them. **A conclusion is only as good as the reader that produced
  it**, and the flag's whole do-not-delete recommendation rested on that one bad read.
- The flag's **filed root cause was wrong again** (it proposed a `library_metadata_overrides` row;
  the real cause was per-track ARTIST being discarded unless albumArtist is Various Artists). That is
  #710, #762, #817, #819 and #851's pattern. The flag did mark it "NOT confirmed", which is the only
  reason it cost nothing.
- Its one *inferred* credit was right: Check U Out now reads **Green Velvet & Gant Garrard**, and
  Gant Garrard is DJ Gant-Man's real name. Inference correctly labelled as inference, later confirmed
  by evidence, is the system working.

#### The 7 fragments: deleted, after proving duplication on both ids

All 7 `Unshakable` fragment albums were verified against their main-album counterparts with
`identify_song` — **14 calls, 14 matches, and every pair shared BOTH `acoustId` and `recordingId`**
(scores 0.97–1.0). Only then deleted. Main album re-read after: 13 tracks intact.

Note the quality direction: the fragments were opus ~184–207 (transcodes of the original FLACs) and
the main-album tracks are mp3 320, so this was **not** "keep the better copy" — it was a wash between
two lossy encodes, and the tie was broken by the main album being the coherent release. Recorded
because the very next cluster inverts it.

#### Sibling agreement is only evidence when the siblings are independent

Two tracks still carry the literal label `Relief Records` as their genre. The album's other 11 read
`Techno`, which looks like an overwhelming sibling majority — and propagating it would have been a
mistag. Those 11 are **all mp3 320 from one rip carrying one blanket album-level genre**; the 2
stragglers are opus 193 from a different rip. The opus fragments *disagreed* with the mp3 rip: the
fragment of *Robots* read `Tech House` where the main album reads `Techno`.

**An 11-way majority sourced from one rip is n=1, not n=11.** The sibling rule needs independent
siblings. Left untagged, deliberately, and not flagged — an unknown genre is worklist material, not a
human-decision blocker.

#### Matias Aguayo *Anenoa* — the same missplit shape, the opposite remediation

Four per-collaborator fragment albums, exactly like Green Velvet. But every fragment is **mp3 320**
and every main-album counterpart is **172–176 kbps**. Here the fragments are the better copies, so
the correct fix is to fold them *in* and delete the main-album copies — the reverse of what was just
done to Green Velvet. **Left for an owner ruling**: destructive, and it inverts the obvious reading.

#### RHCP *Greatest Hits* — the free lane beat the network lane

`lookup_album_metadata` returned five candidates all at **score 100** (1999, 2003, 2005, 2008, 2020):
a tie the scorer cannot break. The stored tracklist breaks it — *"Save the Population"* (track 16) was
written for the 2003 compilation and appears on no earlier one, and *"Universally Speaking"* comes
from *By the Way* (2002), ruling out 1999. Set to 2003. **Read the album you already own before
spending a network call on it.**

#### The finding: a curator genre override is keyed on the least durable id in the system — #856

`song-genre-mutate.ts` says it plainly: *"The tag mirror below is a convenience for external players;
the override is the durability mechanism, in both modes"* — and that row is `key: songId`, i.e.
`sha1(path)`. Measured read-only on prod:

```
song-scope overrides:  total 953   orphaned 290   (30.4%)
  user      replace   171     <- curator decisions
  essentia  (null)    117     <- regenerable
  user      append      2
```

**Severity splits by what happened to the file, and checking that changed the issue.** The first
framing written this session — "essentially every genre decision from sessions 5–6 is gone" — was
wrong:

- **File MOVED** (the reorganize): the tag mirror rescues the value. UMOJA *Vuelo Nocturno*, 8
  `mode:'replace'` writes to `Afrobeat`, all orphaned rows — and all 7 surviving tracks still read
  `Afrobeat`. No visible loss.
- **File REPLACED** (re-encode / re-acquire): total silent loss. The two Green Velvet tracks set to
  `Tech House` last session now read `Techno`, and a direct query for an override on their live ids
  returns **0 rows**.

The subtler half: even where the value survived, the row that was supposed to protect it now points
at a dead id, so the song is tag-governed again with no protection — one bad retag from reverting.
That is #762's exact scenario re-armed.

`orphan-prune.ts` documents this table as `311 rows | 0 orphans`, reasoning that *"the scanner
rebuilds them rather than accumulating"*. True for `library_song_genres` (keyed on the **live** id);
false for an override keyed on a **dead** one. The 0 predates the mass transcode. Curator tables are
correctly excluded from `ORPHAN_TABLES` — they must never be deleted — but nothing repoints them
either, and the fix pattern already exists twice in this repo
(`repointOrphanedAcquisitions`, `repointPlaylistsBeforePrune`).

Filed as **#856**, with the attribution of the 290 to specific events marked explicitly as a
hypothesis rather than a finding.

#### Songs 17,622 → 17,495 against 7 deletions

Same shape as session 6's 426-song delta, and the same suspected cause (the deferred orphan sweep).
**Not asserted here** — session 6 only earned that conclusion by counting audited deletes first, and
this session did not re-run that probe. Recorded as open.

#### Also done

`Los Auténticos Decadentes` was split across three spellings (`Los Autenticos Decadentes`,
`Los Áutenticos Decadentes`, and the correct form). One `merge_artist` batch collapsed all three;
verified on read-back as 9 albums and every song under one artist row. The residual
`Los Autenticos Decadentes;El Gran Silencio` is a compound multi-artist *field*, not an artist row,
and is out of scope for a merge by design.
