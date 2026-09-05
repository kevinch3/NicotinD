# Smart Radio (metadata-driven queue curation)

Radio mode keeps playback going by auto-appending musically similar tracks
when the queue runs low. It replaces the old "shuffle 200 recent songs"
provider with a server-side scoring engine that uses BPM, key, genre, year,
and the perceptual audio axes to find tracks that flow naturally from whatever
is playing.

## How the next track is chosen — in plain language

Radio picks the next track in three steps. This is the reference explanation to
link when someone asks "why did it play that?"; the formula itself is versioned
(see "Calibration history" below).

**1. Gather candidates.** From your own library only, radio collects a few
hundred candidates that plausibly fit the current song: tracks sharing a genre
with it, tracks in a similar tempo range, tracks with similar energy, a small
guaranteed seat for not-yet-analyzed tracks, and a random top-up. Tracks
shorter than 60 seconds never enter (intros, skits, ads), junk genre tags
("Other", "Unknown") don't count as genres, and hidden/quarantined tracks are
never considered.

**2. Score each candidate 0–1 against the current song.** Each criterion below
produces a closeness between 0 and 1; the final score is the weighted average
of the criteria _both tracks actually carry_ — a track missing BPM analysis
competes on what it has instead of being punished for missing data.

| Criterion        | Plain meaning                                                                                                                                                                                         | Weight |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Genre            | Do the two tracks share a style? Any shared genre (even a secondary one) counts fully; no usable genre → a low 0.2 floor. On a **station** this weight is spent on graded membership instead (below). | 18     |
| Sound embedding  | Does it actually _sound_ similar — an ML fingerprint of the audio itself.                                                                                                                             | 8      |
| Origin           | Are the artists from musically related countries/scenes?                                                                                                                                              | 8      |
| Key              | Would a DJ call the musical keys compatible (Camelot wheel)?                                                                                                                                          | 6      |
| Energy           | Same intensity — a quiet ballad shouldn't follow a banger.                                                                                                                                            | 5      |
| Acousticness     | Acoustic textures with acoustic textures.                                                                                                                                                             | 5      |
| BPM              | Similar tempo (the pool is already tempo-filtered, so this is a mild nudge).                                                                                                                          | 4      |
| Valence          | Same emotional brightness (happy vs melancholy).                                                                                                                                                      | 4      |
| Danceability     | Same groove factor.                                                                                                                                                                                   | 3      |
| Instrumentalness | Vocal tracks with vocal tracks, instrumentals with instrumentals.                                                                                                                                     | 3      |
| Year             | Same era, loosely (20-year scale).                                                                                                                                                                    | 2      |

Duration stopped being a scored criterion in formula v7: the sub-60 s pool
floor already removes the interlude/lesson case before scoring, and duration
_closeness_ among real songs measured anti-correlated with listener ratings
(see "Calibration history"). The axis code remains, at weight 0, so
`--weights duration=n` can still measure it.

**3. Apply penalties and pick.** A candidate by the _same artist_ as the seed
loses 0.15, and a track _you_ played in the last 7 days loses up to 0.2 (fading
with time) — nudges, never exclusions. The top scorers win, capped at 2 tracks
per artist.

**Stations work differently.** The three steps above describe radio seeded from
a _song_. When you tap a genre chip or a vibe preset on the landing page there
is no seed song, and step 1 changes completely: the candidates are simply
_everything matching the filter_. That makes the genre criterion useless — every
candidate carries the genre, or it would not be in the pool — so a station
replaces it with a **membership grade**: how prominently the track itself is
filed under the genre, and how much of that artist's catalogue actually lives
there. See "Stations (filter-seeded radio)" below.

**What this affects**: the radio queue (Now Playing radio toggle +
auto-replenish), filter/"vibe" radio and the landing-page presets, and the
"similar songs" suggestions. **What it does not affect**: library
search/filters, playlists, stats, or anything about acquisition.

## How it works

When `radio` is toggled on (Now Playing sheet), `PlayerService` watches the
queue length. Once it drops to 2 tracks, it calls the registered
`RadioProvider`, which hits `GET /api/radio/next` with the current track as
the seed. The server scores a candidate pool against the seed and returns
the top matches, which are appended to the queue. Deduplication against
current + queue + recent history is applied both server-side (via the
`exclude` parameter) and client-side.

### Scoring algorithm

`scoreSimilarity(seed, candidate, weights)` in
`packages/api/src/services/radio.service.ts` is a pure, unit-tested function.
Each factor produces a 0–1 score; the result is a **weight-normalized** blend
(see below), not a raw sum:

| Factor                     | Logic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Weight |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Genre                      | `genreSetCloseness`: **max pairwise `genreCloseness` across the two full genre sets** (`SongFeatures.genres`, primary-first from `library_song_genres`; falls back to the single `genre`). Per pair: exact (case-fold) = 1.0, token-set containment (e.g. "Deep House" ⊇ "House") = 0.6, partial overlap = Jaccard×0.5, disjoint = 0. A shared _secondary_ genre scores like a shared primary — a track tagged "Electronic; House" is an exact match for a "House" seed. **Candidate has no genre while the seed does → `MISSING_GENRE_FLOOR` (0.2), not skipped** (see below). Junk vocab (`JUNK_GENRES`: "Other", "Unknown", …) is filtered out before comparing — two junk tags are _no_ match, not a perfect one (issue #583). | 18     |
| Origin                     | `originSetCloseness` over the credited artists' country sets (docs/artist-origin.md); floored at `MISSING_ORIGIN_FLOOR` (0.2) when the seed knows its origin and the candidate doesn't.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 8      |
| BPM proximity              | 1 − clamp(\|Δbpm\| / seedBpm × 5, 0, 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 4      |
| Key compatibility          | Camelot wheel: same=1.0, A↔B=0.8, ±1 same-ring=0.7, ±2 same-ring=0.4, diagonal (±1 + ring swap)=0.4, else 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 6      |
| Year proximity             | 1 − clamp(\|Δyear\| / 20, 0, 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2      |
| Duration similarity        | 1 − clamp(\|Δdur\| / seedDur, 0, 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 3      |
| Energy closeness           | 1 − \|Δenergy\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 5      |
| Valence closeness          | 1 − \|Δvalence\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 4      |
| Danceability closeness     | 1 − \|Δdanceability\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 3      |
| Instrumentalness closeness | 1 − \|Δinstrumental\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 3      |
| Acousticness closeness     | 1 − \|Δacousticness\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 2      |
| Embedding cosine           | `(cosineSim(seedVec, candVec) + 1) / 2` (only when both carry an Essentia embedding of matching dim)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 8      |
| Artist diversity           | same artist → subtract `artistPenalty` from the normalized score                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 0.15   |

**Weight normalization (why raw sums were wrong mid-backfill).** Each factor is
only _comparable_ when both sides carry it. The scorer accumulates
`scoreAcc += factorScore × weight` and `weightAcc += weight` over the comparable
factors, then `base = scoreAcc / weightAcc` → a `0..1` fit score. An axis missing
on either side is skipped from **both** numerator and denominator, so an
un-analyzed candidate competes on the factors it _has_ instead of being dragged
down by un-measured ones. This removes the old bias where a fully-analyzed
candidate could out-score an un-analyzed one purely for carrying perceptual
features (the reason Radio used to tunnel on whatever slice got enriched first).

**Genre is the one exception: a missing candidate genre is FLOORED, not skipped**
(`MISSING_GENRE_FLOOR = 0.2`). Skipping it inverted the intent — dropping the
(heavily-weighted) genre axis out of the denominator meant an untagged track
competed on BPM/energy alone and could out-rank a real genre neighbour, so
_missing data was rewarded_. With 13% of the real library carrying no genre at all, that was half
the José Larralde incoherence (issue #185). The floor degrades gracefully: an
untagged track is neither excluded from the pool nor treated as a match. Two
boundaries matter — a seed with **no** genre still _skips_ the axis (there is
nothing to compare against; a junk-only genre set — "Other", "Unknown", … — counts
as none on either side, issue #583), and **no other axis floors**, preserving the
un-analyzed-candidate guarantee above. `explainSimilarity` reports these in a
separate `floored[]` list so the diagnostic can still tell a data gap apart from a
genuine weak match.

**Why the embedding weight was left at 4.** Raising it was the cheap mitigation
proposed for genre-poor seeds (issue #185 task A4), so it was measured rather
than assumed: re-ranking the Larralde seed at `embedding` = 4 / 6 / 8 (via
`dump-radio --weights`) moved pool genre-coherence 55% → 56% → 57% — noise. Once
the _data_ was fixed the axis had nothing left to rescue, and every control seed
was already at 12/12 genre matches. Fixing the genre beats reweighting the
scorer; the flag remains so any future weight change can be justified the same
way.

**Genre weight re-measure (task B3) — bumped 10 → 18, and the residual case was real.**
Task B3 warned not to bump the weight blind, and that the missing-genre floor
(above) had likely already closed most of the symptom — both true, but not the
whole story. Measured via `dump-radio --weights genre=N` across 10 real seeds
(the José Larralde + Mercedes Sosa control pair, 4 more well-tagged/random
seeds, and a niche-genre stress seed): **9 of 10 seeds already showed 0/12
"genre lost on weight" tracks at the old weight of 10** — for a typical seed
whose pool shares a reasonable fraction of genre tokens, the floor alone was
enough. But a genuinely sparse-pool seed (a Folktronica track whose candidate
pool shared a genre token with only 15% of the pool, vs. 48–75% for the other
seeds) still let up to 4/12 top tracks be wrong-genre matches that won purely
on BPM/energy/valence fit — the original B3 symptom, alive in the one case
where the pool itself is genre-thin. Swept `genre` at 10/14/16/18/20 against
that seed: 18 was the smallest value that fully closed it (0/12, down from
4/12), and every one of the other 9 seeds stayed at 0/12 across the whole
sweep — no observed over-tunneling. A calibrated synthetic pair reproducing
the exact failure mode (a wrong-genre candidate near-perfect on every other
axis vs. a right-genre candidate merely decent elsewhere) is pinned as a
regression test in `radio.service.test.ts`. One side effect worth naming: as
`genre` rises, previously-just-below-cutoff genre-**floored** candidates (0.2)
start displacing confirmed-wrong-genre ones (0.0) at the bottom of the ranked
list — expected given the floor's design (better than a known-wrong guess,
worse than a real match), and it makes the backfill signal _more_ visible, not
less; the `genre-audio` fallback task (issue #187 A2) directly shrinks that
population over time.

**Genre is now curator-correctable, and that is the highest-leverage lever.**
Issue #187 task A3 added `library_genre_overrides` — a scan-applied side table
that can _replace_ a song's primary genre, not just append to it (see
[library-scanner.md](library-scanner.md) "Genre overrides"). This matters for the
scorer because `genreSetCloseness` is a position-blind **MAX** over every genre
pair: as long as a broad tag genre like `Latin` stays in a track's set, it scores
1.00 against every Latin candidate and no amount of adding specific genres
changes the ranking. A `source='user'` override therefore _replaces_ the set
outright. Measured on the real José Larralde seed: overriding him to
`Folclore;Chacarera` moved his top 12 from Mercedes Sosa / Piazzolla / **Shakira**
/ **Enrique Iglesias** to Atahualpa Yupanqui / Los Nocheros / Los Manseros
Santiagueños / Hernán Figueroa Reyes — genuine Argentine folclore.

**Careful with pool-coherence % across a genre-specificity change.** That metric
(`shares ≥1 genre token w/ seed`) _fell_ 60% → 15% on the same Larralde run that
dramatically improved. It is inflated by a broad seed genre: "Latin" trivially
matched 60% of a Latin-heavy library while meaning nothing. When the seed's genre
specificity changes, compare the ranked output, not the pool percentage.

**Why MusicBrainz can't fix this for you.** Task A1 measured MB/Lidarr genre
coverage on this library at 2/25 artists (~3% of the gap), with Lidarr returning
byte-identical data to MB (it proxies it) and Spotify's API now requiring a
premium subscription for the app owner. MB has _nothing_ for Larralde at artist
level. Release-group level is ~6× better but still leaves the majority
uncovered — which is why the curator UI is the primary path here rather than a
fallback. Full numbers in
[library-scanner.md](library-scanner.md) "Trusted-metadata genre".

Because the score is normalized to `0..1`, the **same-artist adjustment is a
delta in that space** (`base − artistPenalty`, ~0.15 for radio) rather than a
raw-point subtraction — so its strength no longer drifts as the library gets more
analyzed. The per-artist **cap** in `rankCandidates` stays the primary diversity
lever. `/songs/:id/similar` reuses the scorer with `artistPenalty = −0.1` (a small
boost, since same-artist results are wanted there).

The five perceptual axes come from the enrichment tasks (ffmpeg energy +
analysis sidecar — see [audio-ml-enrichment.md](audio-ml-enrichment.md)); the
embedding is the cached Essentia vector in `library_embeddings`, loaded per-pool
by `loadEmbeddings` (`services/embedding-store.ts`) and compared only within the
seed's model. It overlaps the five scalar axes (they are classifier heads over
the same vector), so it's an **augment** weighted modestly.

### Camelot harmonic compatibility

Uses `keyToCamelot()` from `services/key-detection.ts`. Compatible moves on
the Camelot wheel (number distance is circular — 1↔12 wraps):

- **Same code** (e.g. 8B→8B): perfect match (1.0)
- **Same number, different ring** (8B→8A): relative major/minor (0.8)
- **Adjacent number, same ring** (8B→7B or 9B): energy shift (0.7)
- **±2 number, same ring** (8B→6B or 10B): bigger energy jump, still mixable (0.4)
- **Diagonal** (±1 number _and_ a ring swap, 8B→7A or 9A): (0.4)
- **Everything else**: 0

The same `camelotCompatibility` powers `harmonicChain` in
`playlist-recipe.ts`, so the extended tiers also improve DJ-style ordering.

### Candidate pool construction

The `/api/radio/next` endpoint builds a diverse pool in several passes:

1. Shares ANY genre with the seed's full set (primary column OR a
   `library_song_genres` EXISTS, up to 150 random; junk tags — `JUNK_GENRES`,
   e.g. "Other" — are dropped from the seed's set first, issue #583)
   (which genre readers match the set vs the primary: [genre-model.md](genre-model.md))
   1b. **Genre variants** — `LOWER(genre) LIKE '%<longest seed token>%'` (up to 100),
   so "Deep House" also pulls "House"/"Tech House" for `genreCloseness` to score
   (tokens shorter than 4 chars are skipped as non-selective; `longestGenreToken`)
2. Similar BPM range ±15% across all genres (up to 100 random)
3. Energy-adjacent ±0.15 across all genres (up to 100 random; only when the
   seed carries an energy value)
4. **Un-analyzed tracks** — `bpm IS NULL OR energy IS NULL` (up to 30), a
   guaranteed seat so a mid-backfill library stays discoverable and Radio doesn't
   tunnel on the already-analyzed slice
5. Random backfill if the pool is still small

Every pass shares two gates: only landed, non-hidden tracks; and **duration ≥
60 s** (`minCandidateDurationSec`, env `NICOTIND_RADIO_MIN_DURATION` overrides
— the e2e suite sets `0` because its silent fixtures are ~30 s). Sub-minute
files are intros/skits/ads/language lessons, not songs (issue #583: prod had
193 landed sub-60 s tracks, and two 46 s lessons ranked top-2 in a real poll
scenario); demoting them by duration _closeness_ alone measurably wasn't
enough, so they never become candidates at all.

Cached embeddings for the seed + whole pool are then loaded in one query
(`loadEmbeddings`, keyed on the seed's model) and attached before ranking; a
seed with no embedding skips the axis entirely. The `rankCandidates` function
scores all candidates, sorts by score, and applies a per-artist cap (default 2)
to prevent any single artist from dominating the radio queue, plus a
one-row-per-recording collapse (below).

## Same recording, multiple files

A track you own on its album **and** on a compilation is two `library_songs`
rows. Ids are `sha1("song:" + relPath)`, so nothing downstream could tell they
were one thing — and radio has four places that assumed a row *is* a track: the
pool sampler dedups on the row id, `exclude` is a set of row ids, the per-artist
cap counts rows, and the recency demotion was keyed on `play_events.song_id`.

Measured on prod (issue #660): **363 such groups covering 732 rows — 4.8% of the
15,253 rows radio can serve**, 361 of them spanning more than one album, and
**zero** spanning more than one `artist_id`. The effect is exactly what two rows
in one random draw predicts: a duplicated recording was served **1.99×** as
often as a single-file one (0.187 vs 0.094 plays per recording across 1,473
radio plays, ≈5.8σ). Because the demotion never transferred between copies, one
recording came back four times in four and a half minutes, alternating files.

`recordingKey(artistId, title, duration)`
(`services/recording-identity.ts`) is the fix — a pure key, no stored column,
computed from fields every caller already holds:

- **`artist_id`, not the artist string.** It is already
  `sha1("artist:" + normalizeArtistForGrouping(name))`, so it *is* the
  normalized artist, and it carries the alias collapse a fresh normalization
  would miss. Zero of the 363 measured groups spanned two artist ids.
- **`normalizeTitle`** (from `@nicotind/core`), which folds diacritics before
  stripping punctuation.
- **Exact duration.** The admin `/duplicates` report can afford a ±2 s
  tolerance because it greedily clusters the whole library in one pass; every
  consumer here is a *lookup*, and a tolerance is not an equivalence relation,
  so it cannot be a Map key. Widening is a change to make against a
  measurement — the 4.8% above is what exact equality already catches.
- **`null` never groups with anything, including another `null`.** The
  discipline `repointPlaylistsBeforePrune` states in prose, as a return type.
  Both guards fire on real data: `duration` is `NOT NULL DEFAULT 0` and
  `/songs/:id/similar` has no duration gate, so un-scanned rows reach that pool;
  and `normalizeTitle` strips everything outside ASCII `\w\s`, so a CJK-only
  title reduces to `""`.

It is applied in three places. **`rankCandidates`** serves at most one row per
recording and never a copy of the seed — checked *before* the artist counter, so
a dropped copy cannot eat the slot its own twin holds; the highest **score**
wins the tie, not the highest `formatQuality`, because the two rows are not
interchangeable (the compilation copy often carries a worse `year`/`genre`, and
an untagged clone loses on `MISSING_GENRE_FLOOR` at weight 18). **The pool
layer** takes an `excludeKeys` set beside `excludeIds` — needed separately
because `rankCandidates` knows one seed while list radio has up to 20 — free for
the seeds, one chunked primary-key lookup for the client-sent ids, skipped when
that set is empty. **The recency demotion** is keyed on the recording (above).

`/songs/:id/similar` gets the collapse for free, and it had the worst version of
this bug: its pool is the artist's entire catalogue, its seed exclusion is a
single row id, and it scores with `artistPenalty: -0.1` — a *boost*. "Similar to
X" returned X itself, from the other album, as result #1.

Deliberately **not** in scope: deleting duplicates from the library (that is the
admin `/duplicates` report) and SQL-level pool dedup. Radio has to stay correct
on a library that legitimately holds a track on both its album and a
compilation.

## Recently-played demotion (listening history, P3)

Radio subtracts a penalty from any candidate **this listener** played recently,
so a queue stops recycling the same handful of songs.

**It is not a similarity axis, and that is the whole design decision.** Every
other field on `SongFeatures` is compared seed-vs-candidate through
`unitCloseness`; play recency is a property of the _candidate alone_. Running it
through `add()` would literally mean "prefer songs I've played about as often as
the seed", which is meaningless. So it is applied **post-normalization**, in the
same place as `artistPenalty`:

```
base            = weighted mean of the comparable axes
after artist    = base − artistPenalty            (same artist)
final           = after artist − recentPlayPenalty × recentPlayFactor
```

Because the penalty never enters `weightAcc`, it cannot dilute the real axes —
an un-played candidate scores exactly as it did before this existed.

**Decay** is `recentPlayFactor(lastPlayedAt, now, window)`: linear from 1 (just
played) to 0 at the window edge (`RECENT_PLAY_WINDOW_MS`, 7 days), and 0 for
never-played. Linear rather than exponential on purpose — the value shows up in
the diagnostic dump, and "half the window elapsed = half the penalty" is a
sentence a human can check against their own listening. The function is pure and
takes `now`, so the scorer stays clock-free and testable.

`recentPlayPenalty` defaults to **0.2**, just above `artistPenalty` (0.15):
hearing the _same track_ again soon is more jarring than hearing the same
artist. It is a **demotion, not an exclusion** — a hard filter would empty the
pool on a small library, and a genuinely great match should still be able to
win.

**Per-user by construction.** `lastPlayedByRecording(db, userId, now, windowMs)`
reads `play_events`, which is private per user (see
[listening-history.md](listening-history.md)). A denormalized
`library_songs.local_play_count` was rejected for exactly this reason:
`library_songs` is global, so it would blend every user's listening on a shared
server — wrong for a personal radio and a privacy regression. Deriving at query
time also means no backfill and no invalidation.

It counts **every** play event, not just `counted = 1`: for "don't replay this
so soon", starting a track and bailing still means you just heard it — the
opposite of what the stats aggregates want.

**Keyed on the recording, not the row (issue #660).** The map used to be
`MAX(at) GROUP BY song_id`, so playing the album copy of a track left its
compilation copy at `recentPlayFactor = 0` and the demotion — the largest
post-hoc penalty there is — did nothing. It is now keyed on `recordingKey`, and
queried from the *play* side rather than the pool side:

```sql
SELECT p.song_id, s.title, s.artist_id, s.duration, MAX(p.at) AS last_at
  FROM play_events p JOIN library_songs s ON s.id = p.song_id
 WHERE p.user_id = ? AND p.at >= ?          -- now − RECENT_PLAY_WINDOW_MS
 GROUP BY p.song_id
```

That is one statement served by `idx_play_events_user_at` instead of the old
chunked 400-id `IN` loop, and its row count is "distinct songs this listener
played in the window" (tens) rather than the pool size — a saving, not a cost.
Anything older than the window already decayed to 0, so it never needed reading.
Two consequences worth knowing: the map partially survives id churn (a re-minted
row is recovered through its surviving sibling), and it now joins
`library_songs`, so a play whose row has since been pruned drops out.

**No identified listener → no demotion.** The route reads the user defensively
(`c.get('user')?.sub`), so a caller without one gets the pre-existing behaviour
rather than a 500. `/api/radio` was not behind the JWT middleware when this
shipped — which made the demotion inert — and is now gated (issue #461, along
with `/api/catalog`, found in the same audit), so in production there is always
a listener. The defensive read stays: it costs nothing and keeps the scorer
honest if the route is ever exposed to an unauthenticated surface.

Visible in `scripts/dump-radio.ts` as `[recently played −0.NNN]` on the affected
rows — an invisible penalty is an unmeasurable one.

## Stations (filter-seeded radio)

The same endpoint also starts radio from a **`LibraryFilter`** — a mood/genre/bpm
"vibe" (e.g. "happy rock", "120bpm+ danceable") — with **no seed song**. This
powers the radio/mood landing (see [web-ui.md](web-ui.md) → "Mosaic home").

### The problem this path had (formula v3)

Reported from real use: tapping the **Electronic** chip served Calvin Harris
next to Queen and Madonna. They carry the tag; they are not the genre; they are
around 128 BPM. Three separate defects, all specific to this path:

1. **The genre axis was a constant.** Membership in a station pool _is_ the
   genre test, so `genreSetCloseness` against the station genre returned 1.0 for
   every candidate. The heaviest weight in the blend (18 of ~66, ~27%) ordered
   nothing, leaving bpm/energy/duration closeness to decide the station — hence
   "128 BPM ≈ electronic".
2. **The embedding axis never ran at all.** `loadEmbeddings` was called in
   `buildSeedRadio` and `/songs/:id/similar` but **not** in `buildFilterRadio`,
   so the one axis that hears the audio — and the strongest discriminator in the
   #583 poll data (r = +0.32) — was silently skipped for every station. Same
   shape as the #187 B4 bug: a field never plumbed through.
3. **The centroid's genre was a statistic, not the request.** `seedCentroid`
   takes the modal _primary_ genre of a random 300-row sample. On an umbrella
   tag that mostly sits on pop records that comes back as `Pop`, and the axis
   meant to reward genuinely-electronic tracks scored them **0** while rewarding
   the pop ones.

And underneath all three, a wrong objective: ranking by closeness to the pool
**centroid** rewards the most _unremarkable_ member of a tag set. The average of
Queen and Calvin Harris is a point neither is near.

### Graded membership (`services/station-affinity.ts`)

A station now asks "how central is this track to the genre", not "does it carry
the tag". Two signals from data the library already stores:

| Signal           | Source                                                                          | Credit                                             |
| ---------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Tag depth**    | position of the station's genre in the track's own ordered genre set            | primary 1.0 / 2nd 0.7 / 3rd+ 0.45 (`DEPTH_CREDIT`) |
| **Artist share** | fraction of the artist's landed tracks carrying the genre (`artistGenreShares`) | the raw share, 0..1 — no ceiling (see v4 below)    |

`stationAffinity` blends them evenly (`DEPTH_WEIGHT` 0.5) and the result
**replaces the genre axis**, reusing its weight — so the axis varies across the
pool again without rebalancing every other weight. In a breakdown a `station`
axis means filter radio and a `genre` axis means seed radio; the two never
co-occur.

The even blend is the point, not a shrug: **either signal alone can carry a
track**. A Madonna record whose _primary_ genre is Electronic really is an
electronic record and lands mid-table (0.65 against Calvin Harris's 0.95), while
a Queen track wearing the tag third by a 3%-Electronic artist sinks to 0.24. A
**demotion, never an exclusion** — same stance as
`MISSING_GENRE_FLOOR` and `artistPenalty`, and for the same reason: a hard cut
empties the pool on a niche genre, and a genuine one-off by a foreign artist is
exactly what a station should be able to surface.

Matching is case/whitespace-insensitive **exact** equality (`genreKey`),
deliberately the same test the pool SQL used to select the candidate, so grading
can never disagree with membership. There is **no genre taxonomy**: `House` does
not partially match `Electronic`. A House-primary track carrying the umbrella
third scores a low depth but a high artist share, and recovers that way — which
is the blend doing its job. A real hierarchy is the principled fix and remains
deliberately unbuilt (it needs a taxonomy this repo does not have).

### The audio anchor

`anchorCentroid` replaces the pool average as the station's embedding target: an
affinity-weighted, L2-normalised mean over the top `ANCHOR_FRACTION` (0.4) of
members by affinity, then **re-taken over the half of those closest to that first
mean**. A broad tag is genuinely bimodal — an ambient record and a festival
banger both wear "Electronic" — and a single mean of a bimodal set lands in the
empty space between the modes, which is the same failure the affinity grading
exists to fix, one level down. The trim pass commits the anchor to the denser
mode. (`radio.service.ts` scores it through the existing embedding axis;
`dominantEmbeddingModel` picks the vector space, since a station has no seed song
whose model to pin.)

**Measured on prod, most of this machinery is inert** and the docs say so rather
than defending it: the anchor as a whole is genuinely different from the pool
average (cos 0.93–0.97), but `ANCHOR_FRACTION` anywhere from 0.2 to 1.0 lands
within cos 0.987 of 0.4 and leaves the served top-10 unchanged on all eight
landing chips, the trim pass moves it by cos 0.97–0.99 and the served list by
0–1 of 10, and switching the embedding axis off entirely changes 0–2 of 10.
The axis was a real bug (it was never loaded at all before v3), and it is a real
axis; it is not a big lever on this library. Full numbers:
[measurements/radio-stations-2026-08.md](measurements/radio-stations-2026-08.md).

### What is NOT graded

A vibe with no genre — `moods`, bpm, perceptual buckets — keeps the plain genre
axis and the centroid seed, because there is no genre to be central to. A
junk-only station genre (`Other`) is ignored the same way: grading against a
tagger's shrug is worse than not grading.

### Measuring a station

`dump-radio.ts --genre <G>` prints a **Station health** block: what the centroid's
modal genre actually came out as, **what fraction of the pool the plain genre
axis would have scored 1.00** (the constant-axis proof), the tag-depth and
artist-share histograms, embedding coverage, whether an anchor was built, and —
the line that catches the v4 defect — **the spread of the station axis across the
tracks it actually served**. A pool-wide histogram can look healthy while every
served track sits at the ceiling, so the served-window `sd` is the one that says
whether the axis orders the station or merely gates it (under 0.01 it prints
`GATING, NOT ORDERING`). That is the measurement to run per landing chip before
touching a weight.

When `GET /api/radio/next` is called **without** `seedId` but **with** filter
query params (the shared `serializeLibraryFilter` grammar — `mood`, `genre`
(repeated), `bpmMin`, per-axis buckets, …), the route:

1. Parses a `LibraryFilter` via `parseLibraryFilter` (`genre` is read with
   `c.req.queries('genre')` since it's a repeated param). No filter and no seed
   → `400`.
2. Builds the candidate pool as **exactly the set of songs matching the filter**
   — `songFilterWheres(filter, 's')` (from `library-filter-sql.ts`, the same SQL
   builder the library list routes use) spliced into `RADIO_SONG_SELECT`, landed +
   non-hidden, `RANDOM() LIMIT 300`. Unlike seed radio there is **no** cross-genre
   widening: the vibe stays inside the filter.
3. Grades every candidate's **station affinity** (above) when the filter names
   genres — one batched `artistGenreShares` query for the whole pool, never one
   per candidate.
4. Seeds the scorer with the **station's** centroid — `stationCentroid` runs
   `seedCentroid` (reused from `playlist-recipe.ts`) over the *whole eligible
   set*, not the sampled pool — for the scalar axes, **overriding its genre with
   the requested genres** (the listener asked for them; the modal primary is a
   statistic about the tag), and with the **anchor** vector as its embedding.
   The target is a property of the station, so neither the sampler's draw nor
   the caller's `exclude` list may move it (#598, below).
5. Runs the identical `rankCandidates`; returns `Song[]` (`[]` when nothing
   matches — the client surfaces a neutral "no tracks yet" notice, never an error).

**Filter-radio genre-blindness fixed (issue #187 task B4 — historical; v3
supersedes the outcome, not the lesson).** `seedCentroid`
consumes `OrderableRow[]`, but `toOrderable` (`routes/radio.ts`) never copied
`genre`/`genres` onto the row at all — a straightforward missing-field bug,
not a fragmentation problem. `seedCentroid`'s `mode()` therefore always saw an
all-`undefined` array and the centroid came back genre-less, which meant the
genre axis was **skipped for every candidate** in every filter-radio vibe
(confirmed via `dump-radio.ts`: `genre: (none)` and every ranked track showing
`[skipped: genre, …]`, regardless of how genre-coherent the filter's own pool
actually was). Fixed by copying both fields through; `explainSimilarity`'s
existing `seed.genres ?? seed.genre` fallback then picks up the centroid's
modal primary genre and scores it normally — re-measured on a real `genre=
Latin` filter, every one of the top 12 flipped from `[skipped: genre]` to `✓
genre match`. `dump-radio.ts`'s own "carries no genre" diagnostic note and its
seed-features display had the same singular/plural mismatch (checked
`seed.genres` only) and are fixed to use the same fallback.

B4 made the centroid's modal primary genre _reach_ the scorer; v3 found that on
a genre station that value is the wrong thing to score against twice over — it
is a constant when it lands on the station genre and an inversion when it does
not — and replaced it. The lesson B4 actually taught still stands and is worth
re-reading before touching this path: **a field omitted from `toOrderable` never
reaches `seedCentroid`, and the axis dies silently for every station.** That is
also exactly how the embedding axis stayed dark here for as long as it did.

**The `seedCentroid.key` "collapses to C major" investigation — half of it was
wrong, and #598 found the half that mattered.** The modal key genuinely varies
with the filtered pool (a `Rock` filter's centroid differs from `Pop`'s or
`Electronic`'s), and C major does have a real, if modest (~1–2 percentage
point), plurality lead in this library's key distribution. But "repeated draws
of the _same_ filter land on the same key reliably" — which this paragraph
asserted for a year — **is false, and was never measured**. On prod the modal
key of a draw matched the full station's on only 33% of Cumbia draws, 47% of
Electronic, 67% of Latin (see
[measurements/radio-stations-2026-08.md](measurements/radio-stations-2026-08.md)
"#598"). A mode over a 300-row sample of a 3,700-row station is not stable, and
a plurality lead of 1–2 points is precisely the size that sampling noise
overturns. Fixed by taking the centroid over the whole eligible set. The
resulting Camelot compatibility scores in real output are not degenerate
(mostly 0.7–1.0, per the wheel's own adjacency rules) — key isn't dragging the
pool down. A spot check with `--weights key=0` produced an equally coherent
(all-genre-matched) top 12, showing no clear win from dropping it either. Per
the embedding-weight precedent above: measured, found to be noise either way,
left as-is — a properly-justified change would need real evidence, and the
practical harm here does not appear to justify one. Revisit if a real
mis-tracking case turns up.

Client side, `PlayerService.radioFilter` remembers the active vibe so
**auto-replenish stays in-vibe**: the layout `RadioProvider` calls
`getFilterRadio(filter, …)` while `radioFilter` is set, falling back to
seed/shuffle only if the filter is exhausted. `startRadioWithFilter(tracks, filter)`
plays the first track, queues the rest, sets `radio` on, and stores the filter;
starting seed radio or turning radio off clears it.

## Keep the vibe (list-seeded radio)

> **On the mosaic home** (the `''` route) all of the shelves below are flattened
> into one tile field, and every tile — including a recently-played one — starts
> a radio. Recently-played is the only source whose verb changed: it used
> `playWithContext` on the classic landing, which kept the shelf as the queue.
> The mosaic also *draws* rather than fills: ten of the twenty recent plays and
> ten of twenty keep-the-vibe variations, chosen at random per visit, with taste
> breakers filling the rest (`LANE_MIX`, [web-ui.md](web-ui.md)); and it has no
> Resume tile. The shelves themselves still render on `/classic`.

The landing page's "Keep the vibe" shelf recommends **variations of the
recently-played list**: tracks that would come up if a radio were started from
that list. It is `buildListRadio` — the third seeding lane beside seed radio
and filter radio, and deliberately **one generation for the whole list, not one
radio per tile**. The recently-played list is near-homogeneous in practice, so
N× `buildSeedRadio` would run N× the pool queries for near-identical pools and
near-identical picks; instead:

- **Seed** = `seedCentroid` over the seed rows (the artist/starred-set
  reduction playlist recipes already use), with **`genres` replaced by the
  list's real-genre union** — the centroid's modal primary alone would collapse
  a mixed-but-coherent list onto one tag (the same umbrella-tag lesson the
  station centroid learned).
- **Pool** = the exact Pools 1–5 of seed radio, via the shared
  `collectPoolRows` (extracted from `buildSeedRadio` so the two lanes can't
  drift), driven by the genre union + centroid bpm/energy.
- **Audio axis** = the seeds' plain **mean embedding** under the seed set's
  `dominantEmbeddingModel`. Deliberately _not_ `anchorCentroid`: that trims a
  _pool_ to its highest-affinity fraction, which is meaningless for an explicit
  seed list — every seed was really listened to, so every seed counts equally.
- **Exclusion**: every seed is excluded (a "variation of X" must never be X
  itself); the caller's recency demotion applies on top, so the shelf also
  leans away from recently-heard non-seeds.

Web-side, `KeepVibeComponent` renders the shelf **above** the recently-played
one and takes that shelf's rows as its `seeds` input (the landing page reads
them off the child via `viewChild`, so history is fetched exactly once); it
generates once per page visit (`maybeGenerate`'s `fetched` guard — a seeds
re-emit must not churn the tiles mid-browse) and hides itself whenever the
recently-played shelf would (no history, endpoint down, empty generation).
Tapping a tile calls `startRadio(track)` on the recommendation, so the vibe
continues past the tapped track.

## Taste breakers (random, recency-demoted)

The landing page's "Taste breakers" shelf sits directly under "Keep the vibe"
and is its deliberate counterweight: where that shelf converges on the mood the
listener is already in, this one is a uniformly random slice of the landed
library (`GET /api/library/random` via `getRandomSongs`, `ORDER BY RANDOM()`).
Tapping a tile calls `startRadio(track)`, so an unfamiliar song becomes a whole
direction rather than one orphan play.

Two rules distinguish it from the shelves around it.

**It does not gate its fetch on `seeds`.** `KeepVibeComponent` waits for the
recently-played rows because a list-seeded generation is meaningless without
them; random songs are not. Gating here would leave a fresh install — no
history, therefore no seeds — staring at a shelf that never appears. So
`TasteBreakersComponent` fetches a `POOL_SIZE` (24) pool once in `ngOnInit`,
and `picks` is a `computed()` over the live `seeds` input: the shelf paints
immediately and re-orders in place when the history arrives, with no second
request.

**Recent plays are demoted, never excluded.** `picks` orders the pool
unheard-first and then cuts to `SHELF_SIZE` (10), so a recently-played song
falls off the end rather than being filtered out. A hard filter reads fine
against a large library, but the client fetches up to 20 recent plays — a small
library can have every random pick inside that window, and the shelf would
vanish precisely for the listener with the least to explore. This is the same
rule `stationAffinity` follows for genre stations (see "What is NOT graded"):
a demotion, never an exclusion.

## Tastemakers (curated blend radio)

The landing page's "Tastemakers" shelf surfaces the **curated playlists** (the
static shelves + auto recipes, both `kind='curated'` — indistinguishable via
the API by design) as one-tap radios, capped at 10 tiles, hide-when-empty like
its sibling shelves (a fresh install has none until the auto-refresh cadence
runs — which is also why the shelf deliberately has **no loading skeleton**:
it would flash-then-vanish, the exact failure `shouldShowRecentSkeleton`
exists to prevent, and there is no persisted "curated exists" proxy).

Tapping a tile starts a **blend**, composed client-side in
`TastemakersComponent` (no new server surface):

1. a shuffled handful (3) of the shelf's **actual tracks** lead the queue;
2. one list-seeded generation (`getListRadio` over the playlist's first
   20 song ids — the `seedIds` lane caps seeds at 20) fills in **variations**
   behind them. Because of that cap the engine cannot know a >20-song shelf's
   tail songs are members, so the component re-filters the variations against
   the _whole_ playlist id set — "never replay the list" is enforced
   client-side, not by the seed exclusion alone;
3. the result is handed to `PlayerService.startRadioWithTracks(tracks)` — the
   prepared-list sibling of `startRadioWithFilter` (play first, queue rest,
   radio on, filter and context cleared). When the blend drains, the layout
   `RadioProvider`'s **seed lane** continues from the current track; there is
   deliberately no persisted "list vibe" replenish lane in this iteration.

Failure modes degrade rather than dead-end: an empty shelf (a recipe that
matched nothing) toasts instead of silently no-opping, and a radio-engine
failure still plays the picks alone (the seed lane takes over from there).
Curated covers are the designed gradient SVGs bundled with the SPA
(`/playlist-covers/<slug>.svg`) rendered via a plain `<img>` — deliberately
not `<app-cover-art>`, which rewrites `src` through the API base URL (see
docs/curated-playlists.md "Covers").

## API

| Method | Path              | Params                                                                                                                                                                                                                                                                                                                       | Returns                                     |
| ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/radio/next` | **one of** `seedId` (seed radio), `seedIds` (comma-separated, list-seeded "keep the vibe" — capped at 20, unknown ids skipped, 404 only when none resolve) **or** a serialized `LibraryFilter` (filter radio — `mood`, `genre`, `bpmMin`, axis buckets, …); plus `exclude` (comma-separated IDs), `count` (1–50, default 10) | `Song[]` (`[]` if a filter matches nothing) |

## Perceptual features (shipped)

The Essentia/ffmpeg enrichment landed exactly along the planned extension
points: `SongFeatures` carries `energy`/`valence`/`danceability`/
`instrumental`/`acousticness` **plus the cached `embedding`**, `scoreSimilarity`
scores them as weight-normalized closeness axes (table above), and the radio
route + RadioProvider were unchanged apart from the extra pools + embedding
load. Sequencing on top of selection lives in `playlist-recipe.ts`:
`orderTracks('energy-arc')` (ramp-up → peak → ramp-down) and the energy term
inside `harmonicChain`.

## Human-graded dataset (radio evaluation polls)

The developer-only dump below answers "why did the engine rank this here?"; the
**human** counterpart is [radio-eval-polls.md](radio-eval-polls.md) — an admin
freezes real radio scenarios behind a public link and anonymous raters thumb
each next-up suggestion, producing a `(seed, candidate, verdict)` dataset with
the per-axis explanations attached. Weight changes can now be scored against
human consensus (export script + `--weights` A/B) instead of only against a
developer's read of a dump. `scripts/eval-radio-poll.ts` is that measurement:
it replays every poll's frozen scenarios under the current (or
`--weights`-overridden) weight set and reports per-poll + pooled agreement AUC,
grouped by `formula_version` (see "Calibration history").

## Calibration history (formula versions)

`RADIO_FORMULA_VERSION` (`radio.service.ts`) names the scoring formula. It is
stamped onto every evaluation poll (`radio_polls.formula_version`) so votes
graded under different formulas are never pooled into one number, and it must
be bumped on ANY change to `DEFAULT_WEIGHTS`, an axis formula, a floor/penalty,
or a pool rule. The per-scenario snapshots still store the exact weight set
used — the version is the human/grouping label, not the ground truth.

- **v1** (original → 2026-08): genre 18 (10 before #187 B3) / origin 8 / bpm 8
  / key 6 / year 2 / duration 1 / energy 5 / valence 4 / danceability 3 /
  instrumental 3 / acousticness 2 / embedding 4; junk genre tags matched
  (`"Other" = "Other"` → 1.0); no pool duration floor.
- **v2** (2026-08-20, issue #583): calibrated against the first human poll data
  — 3 polls, 28 scenarios, 70 votes from 3 raters (one rater per poll: a small,
  preliminary dataset). Findings: v1 ordered its own top-5 _worse than random_
  (within-scenario pairwise AUC 0.43 against the votes, and up-rate _rose_ with
  rank); the genre axis was saturated (max-pairwise = 1.0 for any shared genre,
  junk included — Welsh language lessons ranked #1 via `"Other" = "Other"`;
  prod had 261 landed "Other" songs); 46 s lessons and a 4 s clip reached real
  queues while duration carried weight 1; embedding was the strongest positive
  discriminator (point-biserial r = +0.32) at the smallest perceptual weight;
  bpm closeness was consistently _negative_ within the served queue. Changes:
  duration 1→3, bpm 8→4, embedding 4→8; junk genres no longer match
  (`isRealGenre`); the pool excludes sub-60 s tracks. Replay agreement (v2
  weights over the frozen v1 top-5s): pooled AUC 0.43 → 0.55 — honest but
  modest, because the biggest fix (the pool duration floor) removes bad
  candidates _before_ scoring and is invisible to a replay of already-served
  candidates. 70 votes cannot support a fully fitted weight vector
  (leave-one-poll-out cross-validation collapses to ~0.5 AUC), so only these
  surgical, pre-registered moves shipped.

- **v3** (2026-08-20, stations): _argued from mechanism, not from data._ Three
  defects on the filter-radio path, all structural: the genre axis was
  **degenerate** (pool membership _is_ the genre test, so `genreSetCloseness`
  returned 1.00 for every candidate — confirmed on prod at **300/300** for an
  Electronic station — and the heaviest weight in the blend, 18 of ~66, ordered
  nothing); embeddings were **never loaded** on this path at all; and the seed's
  modal primary genre could come back as a _different_ genre than the one the
  listener asked for. Changes: graded `stationAffinity` replaces the genre axis
  and reuses its weight, `dominantEmbeddingModel` + `loadEmbeddings` light the
  audio axis, `anchorCentroid` replaces the pool average, the requested genres
  overwrite the centroid's. The constants (`DEPTH_CREDIT`, `SHARE_REFERENCE`,
  `DEPTH_WEIGHT`, `ANCHOR_FRACTION`) shipped **unmeasured** — no station vote
  existed to tune against, and the file that says so is
  [measurements/radio-stations-2026-08.md](measurements/radio-stations-2026-08.md).
- **v4** (2026-08-20, first prod measurement of the station half — 15,162 landed
  songs, 16,121 embeddings, the eight landing chips, replayed through the real
  `buildFilterRadio`). Read as a tasting note, because a blend is what this is:

  **The v3 nose was right.** Grading membership instead of testing it is the
  correct move and it shows: the station axis is the widest-spread axis in the
  pool on 6 of 8 chips (weight × sd = 2.77–3.98, 23–28% of all usable spread),
  and it genuinely re-orders — only 3–8 of v2's top-10 survive into v3's, with
  Kendall τ 0.57–0.80 over the full pool. Nothing below argues for going back.

  **The palate was thin, and in one specific place.** v3 softened artist share
  through a `SHARE_REFERENCE` of 0.5 — full marks to any artist at least half of
  whose catalogue wears the tag — reasoning that a genuine genre artist is rarely
  100%. On the real cellar that ceiling put **23–74% of every station pool at
  exactly 1.00**, and because the served top-10 is drawn out of that tie, the
  axis scored **sd 0.000 across the served window on five of the eight chips**.
  It decided who was in the room and then said nothing about who got played:
  within the served top-30 the list was actually ordered by Camelot key
  (spread 1.55–2.48) and artist origin (1.21–3.02). v3 moved the degeneracy from
  the pool to the window rather than removing it.

  **The other half of the blend was over-extracted for a fruit that isn't in
  this vineyard.** The measurement protocol named its own falsification test —
  the "under 10% artist share" bucket, the Queen-on-an-Electronic-station
  population — and said that if it were near zero the share half was not earning
  its keep. It is **1.0%–3.2% on every chip**. Share still belongs in the blend
  (it is barely correlated with depth, r = 0.06–0.58, so it carries independent
  information), but it was being asked to grade a case that hardly occurs.

  **The v4 change is one constant, deleted.** Artist share is used raw. Ties fall
  to 7–27% of pool, the served-window sd goes to **0.004–0.099 — non-zero on all
  eight chips** — and the station axis enters the top three ordering forces of the
  served window on 6 of 8 (was 3 of 8). The design intent survives intact: a
  genre native scores 0.96–0.99, a real record by a mostly-foreign artist 0.64–0.66
  (still mid-table, still served), a third-position tag by a 3% artist 0.26–0.27.

  **What was deliberately NOT changed, and why that is a finding.** `DEPTH_CREDIT`:
  five curves from `[1,.8,.6,.5]` to `[1,.5,.2,.1]` move the served top-10 by
  0–2 of 10, because that window is drawn almost entirely from primary-tagged
  tracks — the tail only re-orders tracks nobody hears, so tuning it is
  unfalsifiable on this library. `DEPTH_WEIGHT`: anything in 0.25–0.75 is
  identical on the served list; only the extremes move 1–2. `ANCHOR_FRACTION`
  and the anchor trim pass: 0 and 0–1 of 10 respectively. Changing an inert
  constant would have produced a version bump, a changelog line and a story,
  and moved zero tracks.

  **Still open, and not claimed.** v4 is argued from prod _mechanism_, not from
  votes: the four polls on prod are all seed-radio (v2), so `eval-radio-poll.ts`
  has nothing to replay for a station. And the loudest unexplained number in the
  study is not the station axis at all — **artist origin, at weight 8, is the #1
  or #2 ordering force inside the served window of every chip** (up to 3.21 on
  Alternative Rock), which is a product question nobody has answered: should a
  genre station prefer artists from the pool's modal country?

- **v6 first human measurement (2026-08-29)** — 120 votes / 5 raters / 2 polls
  (five seed scenarios; three stations + two seeds), the first votes collected
  under v6 and the first from raters outside the household. Headline: pooled
  v6·binary AUC **0.522 over 23 pairs** (~random, n far too small to move
  weights). The sharper finding is about the *instrument*, not the formula:
  with 2–3 raters, binary thumbs tie constantly and the majority consensus
  discarded most of the effort — one poll's 25 graded candidates yielded only
  **4 usable pairs**. That, plus the first outside rater's own ask ("1-5 sería
  mejor", plus skip and clearer framing), produced the stars5 vote scale +
  skippable wizard (issues #798–#800); v6·stars5 accumulates as its own fresh
  baseline and is never pooled with these numbers. Also measured: approval 84%
  (genre poll) vs 64% (seed poll); **no rank-position decay** across ranks 1–5;
  and the downvote post-mortem splits cleanly into formula misses (cross-genre
  leakage: Eminem served after Metallica's *Battery*, Downtempo/Britpop after
  Radiohead) and **library mistags surfacing through radio** (a Rampa remix
  tagged Death Metal, Guasones tagged Pop, a junk "Metal Cover" novelty in the
  Metal station) — the latter are curation work and say nothing about weights.

- **v7** (2026-09-01, issue #861): calibrated on the first stars5 data — two
  polls closed 08-30/31: "Latin taste control (V6)" (25 votes / 1 rater,
  including the **first two station scenarios ever voted**) and "Genre taste
  control (v6 - star)" (50 votes / 2 raters). Baseline: pooled v6·stars5 AUC
  **0.592 over 71 pairs** (Latin 0.710, Genre-star 0.500) — the star scale
  tripled the informative pairs the same vote volume yielded under binary
  (23 → 71), which is what #800/#802 predicted. Single-axis agreement over all
  71 pairs: acousticness **0.655** (on the smallest perceptual weight, 2), key
  0.642, energy 0.620 … duration **0.415** (anti-correlated); genre tied on
  50/50 pairs and origin on 49/58 — both order-dead _within the served window_
  (off-policy: they pick the pool, then have nothing left to order), so these
  polls cannot measure weights 18/8 at all. Changes: **duration 3→0**
  (v2 raised it to flag junk content; v2's own sub-60 s pool floor now removes
  that case before scoring) and **acousticness 2→5**. Replay agreement:
  stars5 pooled 0.592 → **0.704** (both polls improve, ≈0.81 / 0.625) and the
  v6-binary group 0.522 → **0.696** — consistent across all four v6 polls and
  both scales. Measured and rejected: `danceability=0` (0.535, hurts),
  `embedding=12` / `key=10` / `year=0` (wash). Same discipline as v2: 3–4
  raters and 94 v6 pairs support surgical pre-registered moves, not a fitted
  vector. The bump also fences off #859's station-target fix
  (`stationCentroid`): the 12 station pairs above were voted under the
  pre-#859 wobbly sampler — every served candidate rated 1–2★ (a
  pool-selection failure the AUC cannot see) — and must never pool with
  post-fix station votes (#600). One curation finding worth repeating: the
  worst seed scenario's seed still carries the junk genre "Music" on prod, so
  the two identity axes were blind — no weight change fixes a mistag.

- **v8** (2026-09-05, issue #642): three composite descriptor axes — timbre
  (21 z-scored MFCC/spectral values, cosine, weight 6), groove (8 z-scored
  beat/onset statistics, cosine, weight 5) and spectral balance (6 band shares,
  `1 - L1/2`, weight 3). The blend had no axis for what the drums do or where
  the spectral energy sits, so two tracks at the same bpm tied there.
  `descriptorBlocks` splits a `library_song_descriptors` row into the three
  blocks by name; `blockCosineCloseness` and `spectralBalanceCloseness` score
  them; `DESCRIPTOR_NORM` holds the z-score constants, measured from this
  library by `measure-descriptor-stats.ts` rather than assumed. A candidate
  with no descriptors skips all three axes, as every un-analysed candidate
  always has.

  **The weights are priors, not measurements.** No poll has graded them: the
  v1–v7 snapshots carry no descriptor blocks, so none of the accumulated votes
  can grade v8, and `evaluatePollAgreement` will report nothing for it until a
  v8 poll is run. That is the next step, and 6/5/3 should be treated as a
  starting point rather than a result.

  This work branched as **v5** and the comment in `radio.service.ts` said so;
  v5, v6 and v7 all shipped underneath it while it sat unrebased. A formula
  that adds three axes must not pool its votes with any of them, so it takes
  the next free number instead of the one it reserved.

Measure any weight idea against the accumulated votes before shipping it:

```bash
bun run packages/api/src/scripts/eval-radio-poll.ts --weights bpm=2,embedding=12
```

## Diagnostic dump (developer tool)

`scripts/dump-radio.ts` generates a radio the **exact** way `GET /api/radio/next`
does and writes a markdown (`--json` optional) report Claude/you can read — no DB
row, no toast, no UI. It exists to answer "why is this radio incoherent?" with
data instead of guesswork (the driving case: a José Larralde **Folk/Chamamé**
seed pulling in pop). Read-only; opens `<dataDir>/nicotind.db` directly.

```bash
bun run packages/api/src/scripts/dump-radio.ts --seed <songId>
bun run packages/api/src/scripts/dump-radio.ts --artist "José Larralde" --count 12
bun run packages/api/src/scripts/dump-radio.ts --random          # random-sample a seed
bun run packages/api/src/scripts/dump-radio.ts --bpm-min 115 --bpm-max 125   # filter vibe
bun run packages/api/src/scripts/dump-radio.ts --seed <id> --weights embedding=8,genre=14
```

`--weights axis=n,…` re-ranks the same seed under a candidate `DEFAULT_WEIGHTS`
(threaded into `buildSeedRadio`/`buildFilterRadio` via `rankCandidates`'s existing
`weights` option), so a proposed weight change can be **measured against a control
seed before it ships** instead of guessed. `parseWeightOverrides` throws on an
unknown axis or a non-numeric value — a silent no-op would invalidate the
measurement.

The route and the dump share **one** implementation: `buildSeedRadio` /
`buildFilterRadio` (exported from `routes/radio.ts`) build the pool + rank; the
route maps to Songs via `radioSongs`, the dump additionally re-runs the scorer's
breakdown per candidate. That breakdown is the new **`explainSimilarity`**
(`radio.service.ts`) — a pure per-axis decomposition of `scoreSimilarity` (which
now delegates to it). Each axis reports `{value, weight, contribution}`; `skipped`
names axes dropped because a side lacked the feature, and `floored` names axes
scored at a floor because the _candidate_ lacked data the seed had. The
distinction is the whole point: **genre in `axes` with value 0** = disjoint tags
lost on _weight_; **`"genre"` in `floored`** = the track has no genre _data_
(scored at 0.2, see "Scoring algorithm"); **`"genre"` in `skipped`** = the _seed_
has no genre. Three different fixes.

The dump's "Detection & algorithm — improvement targets" section auto-flags, from
the actual run: (1) _genre-less candidates_ — how many output tracks carried no
genre data; now a **backfill** signal (re-source the genre) rather than a scorer
bug, since the floor stopped rewarding them; (2) _genre-lost-on-weight_ —
`DEFAULT_WEIGHTS.genre` (10/~44 ≈ 23%) too low to keep a wrong-genre track down;
(3) _genre-detection miss_ — un-split concatenated tags (`LatinWorld`,
`EuropopPopSoftRock…`) that `splitGenres` didn't break, so genre closeness sees one
giant token (`looksConcatenatedGenre` flags them; fix them with
`reclassify-genres.ts --propose` → `--apply` → `--backfill`); (4) _key-detection
instability_ — a one-artist set spanning many keys with key axes scoring 0. Also
surfaced: filter radio seeds on the pool **centroid**, which carries **no genre**
(and a near-constant `C major` key), so the genre axis is skipped for every
candidate — a bpm-only vibe has no genre cohesion by design.

### Case study: the José Larralde fix (issue #185)

The bug the tool was built for, and the shape of an evidence-driven fix. A Folk /
Chamamé seed pulled in Katy Perry / Chris Brown / Rihanna. Measured on the real
14,469-track library:

|                           | pool sharing ≥1 genre token | top-12                                        |
| ------------------------- | --------------------------- | --------------------------------------------- |
| Before                    | **8%**                      | 6/12 genre-less, real folk pushed out         |
| After (floor only)        | 8%                          | genre-less tracks demoted, pool still starved |
| After (floor + tag split) | **55%**                     | **12/12 genre matches**                       |

Root cause was _data_, not math: the seed's only tag was `"LatinWorld"`, one
un-split concatenation matching nothing but other identically-mis-tagged tracks,
so the pool starved and filled with genre-less, BPM-matched pop. Splitting it to
`Latin` + `World` refilled the pool; the missing-genre floor kept the untagged
tracks from winning on the axes they _did_ have. Neither change alone was enough —
and raising the embedding weight, the third hypothesis, measured as noise.

Note what is _not_ fixed: `Latin;World` is still not `Folk`/`Chamamé`, so the
output is Latin-broad (Piazzolla and Goyeneche, but also Shakira). Re-sourcing the
_real_ genre from trusted metadata is tracked separately.

## Shared scoring with `/songs/:id/similar`

The `/songs/:id/similar` endpoint reuses the same `rankCandidates` and
`scoreSimilarity` functions with different weights (same-artist is boosted
`−0.1` in normalized space rather than penalized, and the per-artist cap is
higher) and loads embeddings the same way. This means any improvement to the
scoring engine benefits both features — including the one-row-per-recording
collapse, which it needed most (see "Same recording, multiple files").

## Code map

| File                                                                  | Role                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api/src/services/radio.service.ts`                          | Pure scoring: `scoreSimilarity` (delegates to) `explainSimilarity` (per-axis breakdown), `genreCloseness`, `cosineSim`, `camelotCompatibility`, `rankCandidates`, `MISSING_GENRE_FLOOR`, `RADIO_FORMULA_VERSION`, `parseWeightOverrides`, types                |
| `packages/api/src/services/radio.service.test.ts`                     | Unit tests for scoring logic + `explainSimilarity` breakdown/delegation                                                                                                                                                                                        |
| `packages/api/src/services/radio-poll-eval.ts`                        | Replay agreement (issue #583): `evaluatePollAgreement` re-scores frozen poll scenarios under any weight set (axes recomputed from features, embedding folded in from its frozen value) → within-scenario pairwise AUC vs the human consensus                   |
| `packages/api/src/scripts/eval-radio-poll.ts`                         | CLI over it — per-poll + pooled AUC grouped by `formula_version`, `--weights` A/B, read-only DB open                                                                                                                                                           |
| `packages/api/src/services/recording-identity.ts`                      | `recordingKey` — pure "is this the same recording?" grouping key (artist id + normalized title + exact duration, or `null`), so two files of one track can't both be served (issue #660)                                                        |
| `packages/api/src/services/station-affinity.ts`                       | **Stations (v3)**: `genreDepthScore` / `stationAffinity` / `anchorCentroid` — pure graded membership + the audio anchor                                                                                                                                        |
| `packages/api/src/services/genre-distribution.ts`                     | `artistGenreShares` — batched "how much of this artist is this genre", the artist half of station affinity (shares the radar's definition)                                                                                                                     |
| `packages/api/src/services/embedding-store.ts`                        | `loadEmbeddings` / `embeddingModelFor` / `dominantEmbeddingModel` — pooled read of cached Essentia vectors (the last picks a station's vector space, which has no seed song to pin)                                                                            |
| `packages/api/src/routes/radio.ts`                                    | `/api/radio/next` route (seed **and** filter paths); exports the shared generators `buildSeedRadio` / `buildFilterRadio` / `radioSongs` (pool build + rank, optional `weights` override for the dump), `toOrderable` (via `songFilterWheres` + `seedCentroid`), `stationCentroid` (the station's target, over the whole eligible set) |
| `packages/api/src/services/genre-split.ts`                            | `segmentConcatenatedGenre` — splits mashed genre tags feeding the genre axis (see [library-scanner.md](library-scanner.md))                                                                                                                                    |
| `packages/api/src/scripts/dump-radio.ts`                              | Developer diagnostic dump (read-only) — see "Diagnostic dump" above; `looksConcatenatedGenre` flags un-split genre tags, `parseWeightOverrides` backs `--weights`                                                                                              |
| `packages/api/src/routes/radio.test.ts`                               | Route tests (incl. filter-radio cases)                                                                                                                                                                                                                         |
| `packages/api/src/routes/library.ts`                                  | `/songs/:id/similar` refactored to use shared scorer                                                                                                                                                                                                           |
| `packages/web/src/app/services/api/library-api.service.ts`            | `getRadioNext()` + `getFilterRadio()` API methods                                                                                                                                                                                                              |
| `packages/web/src/app/services/player.service.ts`                     | `radioFilter` signal + `startRadioWithFilter()` (persisted vibe)                                                                                                                                                                                               |
| `packages/web/src/app/components/layout/layout.component.ts`          | Smart RadioProvider registration (filter-aware)                                                                                                                                                                                                                |
| `packages/web/src/app/pages/mosaic-home/mosaic-home.component.ts` | The home route: one pannable mosaic, every tile a radio start                                                                                                                                                                                                |
| `packages/web/src/app/pages/radio-landing/radio-landing.component.ts` | Classic landing at `/classic`: resume, shelves, vibe tiles + genre tiles                                                                                                                                                                                               |
