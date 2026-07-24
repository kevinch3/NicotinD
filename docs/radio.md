# Smart Radio (metadata-driven queue curation)

Radio mode keeps playback going by auto-appending musically similar tracks
when the queue runs low. It replaces the old "shuffle 200 recent songs"
provider with a server-side scoring engine that uses BPM, key, genre, year,
and duration to find tracks that flow naturally from whatever is playing.

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

| Factor                     | Logic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Weight |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Genre                      | `genreSetCloseness`: **max pairwise `genreCloseness` across the two full genre sets** (`SongFeatures.genres`, primary-first from `library_song_genres`; falls back to the single `genre`). Per pair: exact (case-fold) = 1.0, token-set containment (e.g. "Deep House" ⊇ "House") = 0.6, partial overlap = Jaccard×0.5, disjoint = 0. A shared _secondary_ genre scores like a shared primary — a track tagged "Electronic; House" is an exact match for a "House" seed. **Candidate has no genre while the seed does → `MISSING_GENRE_FLOOR` (0.2), not skipped** (see below). | 10     |
| BPM proximity              | 1 − clamp(\|Δbpm\| / seedBpm × 5, 0, 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 8      |
| Key compatibility          | Camelot wheel: same=1.0, A↔B=0.8, ±1 same-ring=0.7, ±2 same-ring=0.4, diagonal (±1 + ring swap)=0.4, else 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 6      |
| Year proximity             | 1 − clamp(\|Δyear\| / 20, 0, 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2      |
| Duration similarity        | 1 − clamp(\|Δdur\| / seedDur, 0, 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 1      |
| Energy closeness           | 1 − \|Δenergy\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 5      |
| Valence closeness          | 1 − \|Δvalence\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 4      |
| Danceability closeness     | 1 − \|Δdanceability\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 3      |
| Instrumentalness closeness | 1 − \|Δinstrumental\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 3      |
| Acousticness closeness     | 1 − \|Δacousticness\| (only when both sides present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2      |
| Embedding cosine           | `(cosineSim(seedVec, candVec) + 1) / 2` (only when both carry an Essentia embedding of matching dim)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 4      |
| Artist diversity           | same artist → subtract `artistPenalty` from the normalized score                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 0.15   |

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
nothing to compare against), and **no other axis floors**, preserving the
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
worse than a real match), and it makes the backfill signal *more* visible, not
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
   `library_song_genres` EXISTS, up to 150 random)
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

Cached embeddings for the seed + whole pool are then loaded in one query
(`loadEmbeddings`, keyed on the seed's model) and attached before ranking; a
seed with no embedding skips the axis entirely. The `rankCandidates` function
scores all candidates, sorts by score, and applies a per-artist cap (default 2)
to prevent any single artist from dominating the radio queue.

## Filter-seeded radio (a "vibe" instead of a seed song)

The same endpoint also starts radio from a **`LibraryFilter`** — a mood/genre/bpm
"vibe" (e.g. "happy rock", "120bpm+ danceable") — with **no seed song**. This
powers the radio/mood landing (see [web-ui.md](web-ui.md) → "Radio landing").

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
3. Seeds the scorer with the pool's **centroid** (`seedCentroid`, reused from
   `playlist-recipe.ts`) so ranking keeps the set coherent while the per-artist
   cap diversifies.
4. Runs the identical `rankCandidates`; returns `Song[]` (`[]` when nothing
   matches — the client surfaces a neutral "no tracks yet" notice, never an error).

Client side, `PlayerService.radioFilter` remembers the active vibe so
**auto-replenish stays in-vibe**: the layout `RadioProvider` calls
`getFilterRadio(filter, …)` while `radioFilter` is set, falling back to
seed/shuffle only if the filter is exhausted. `startRadioWithFilter(tracks, filter)`
plays the first track, queues the rest, sets `radio` on, and stores the filter;
starting seed radio or turning radio off clears it.

## API

| Method | Path              | Params                                                                                                                                                                                             | Returns                                     |
| ------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/radio/next` | **either** `seedId` (seed radio) **or** a serialized `LibraryFilter` (filter radio — `mood`, `genre`, `bpmMin`, axis buckets, …); plus `exclude` (comma-separated IDs), `count` (1–50, default 10) | `Song[]` (`[]` if a filter matches nothing) |

## Perceptual features (shipped)

The Essentia/ffmpeg enrichment landed exactly along the planned extension
points: `SongFeatures` carries `energy`/`valence`/`danceability`/
`instrumental`/`acousticness` **plus the cached `embedding`**, `scoreSimilarity`
scores them as weight-normalized closeness axes (table above), and the radio
route + RadioProvider were unchanged apart from the extra pools + embedding
load. Sequencing on top of selection lives in `playlist-recipe.ts`:
`orderTracks('energy-arc')` (ramp-up → peak → ramp-down) and the energy term
inside `harmonicChain`.

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
scoring engine benefits both features.

## Code map

| File                                                                  | Role                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api/src/services/radio.service.ts`                          | Pure scoring: `scoreSimilarity` (delegates to) `explainSimilarity` (per-axis breakdown), `genreCloseness`, `cosineSim`, `camelotCompatibility`, `rankCandidates`, `MISSING_GENRE_FLOOR`, types                                                                 |
| `packages/api/src/services/radio.service.test.ts`                     | Unit tests for scoring logic + `explainSimilarity` breakdown/delegation                                                                                                                                                                                        |
| `packages/api/src/services/embedding-store.ts`                        | `loadEmbeddings` / `embeddingModelFor` — pooled read of cached Essentia vectors                                                                                                                                                                                |
| `packages/api/src/routes/radio.ts`                                    | `/api/radio/next` route (seed **and** filter paths); exports the shared generators `buildSeedRadio` / `buildFilterRadio` / `radioSongs` (pool build + rank, optional `weights` override for the dump), `toOrderable` (via `songFilterWheres` + `seedCentroid`) |
| `packages/api/src/services/genre-split.ts`                            | `segmentConcatenatedGenre` — splits mashed genre tags feeding the genre axis (see [library-scanner.md](library-scanner.md))                                                                                                                                    |
| `packages/api/src/scripts/dump-radio.ts`                              | Developer diagnostic dump (read-only) — see "Diagnostic dump" above; `looksConcatenatedGenre` flags un-split genre tags, `parseWeightOverrides` backs `--weights`                                                                                              |
| `packages/api/src/routes/radio.test.ts`                               | Route tests (incl. filter-radio cases)                                                                                                                                                                                                                         |
| `packages/api/src/routes/library.ts`                                  | `/songs/:id/similar` refactored to use shared scorer                                                                                                                                                                                                           |
| `packages/web/src/app/services/api/library-api.service.ts`            | `getRadioNext()` + `getFilterRadio()` API methods                                                                                                                                                                                                              |
| `packages/web/src/app/services/player.service.ts`                     | `radioFilter` signal + `startRadioWithFilter()` (persisted vibe)                                                                                                                                                                                               |
| `packages/web/src/app/components/layout/layout.component.ts`          | Smart RadioProvider registration (filter-aware)                                                                                                                                                                                                                |
| `packages/web/src/app/pages/radio-landing/radio-landing.component.ts` | Radio/mood landing: resume shortcut + vibe presets + genre chips                                                                                                                                                                                               |
