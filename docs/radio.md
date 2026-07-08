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

| Factor | Logic | Weight |
|--------|-------|----------------|
| Genre | `genreCloseness`: exact (case-fold) = 1.0, token-set containment (e.g. "Deep House" ⊇ "House") = 0.6, partial overlap = Jaccard×0.5, disjoint = 0 | 10 |
| BPM proximity | 1 − clamp(\|Δbpm\| / seedBpm × 5, 0, 1) | 8 |
| Key compatibility | Camelot wheel: same=1.0, A↔B=0.8, ±1 same-ring=0.7, ±2 same-ring=0.4, diagonal (±1 + ring swap)=0.4, else 0 | 6 |
| Year proximity | 1 − clamp(\|Δyear\| / 20, 0, 1) | 2 |
| Duration similarity | 1 − clamp(\|Δdur\| / seedDur, 0, 1) | 1 |
| Energy closeness | 1 − \|Δenergy\| (only when both sides present) | 5 |
| Valence closeness | 1 − \|Δvalence\| (only when both sides present) | 4 |
| Danceability closeness | 1 − \|Δdanceability\| (only when both sides present) | 3 |
| Instrumentalness closeness | 1 − \|Δinstrumental\| (only when both sides present) | 3 |
| Acousticness closeness | 1 − \|Δacousticness\| (only when both sides present) | 2 |
| Embedding cosine | `(cosineSim(seedVec, candVec) + 1) / 2` (only when both carry an Essentia embedding of matching dim) | 4 |
| Artist diversity | same artist → subtract `artistPenalty` from the normalized score | 0.15 |

**Weight normalization (why raw sums were wrong mid-backfill).** Each factor is
only *comparable* when both sides carry it. The scorer accumulates
`scoreAcc += factorScore × weight` and `weightAcc += weight` over the comparable
factors, then `base = scoreAcc / weightAcc` → a `0..1` fit score. An axis missing
on either side is skipped from **both** numerator and denominator, so an
un-analyzed candidate competes on the factors it *has* instead of being dragged
down by un-measured ones. This removes the old bias where a fully-analyzed
candidate could out-score an un-analyzed one purely for carrying perceptual
features (the reason Radio used to tunnel on whatever slice got enriched first).

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
- **Diagonal** (±1 number *and* a ring swap, 8B→7A or 9A): (0.4)
- **Everything else**: 0

The same `camelotCompatibility` powers `harmonicChain` in
`playlist-recipe.ts`, so the extended tiers also improve DJ-style ordering.

### Candidate pool construction

The `/api/radio/next` endpoint builds a diverse pool in several passes:

1. Same genre as seed (exact, up to 150 random)
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

## API

| Method | Path | Params | Returns |
|--------|------|--------|---------|
| GET | `/api/radio/next` | `seedId` (required), `exclude` (comma-separated IDs), `count` (1–50, default 10) | `Song[]` |

## Perceptual features (shipped)

The Essentia/ffmpeg enrichment landed exactly along the planned extension
points: `SongFeatures` carries `energy`/`valence`/`danceability`/
`instrumental`/`acousticness` **plus the cached `embedding`**, `scoreSimilarity`
scores them as weight-normalized closeness axes (table above), and the radio
route + RadioProvider were unchanged apart from the extra pools + embedding
load. Sequencing on top of selection lives in `playlist-recipe.ts`:
`orderTracks('energy-arc')` (ramp-up → peak → ramp-down) and the energy term
inside `harmonicChain`.

## Shared scoring with `/songs/:id/similar`

The `/songs/:id/similar` endpoint reuses the same `rankCandidates` and
`scoreSimilarity` functions with different weights (same-artist is boosted
`−0.1` in normalized space rather than penalized, and the per-artist cap is
higher) and loads embeddings the same way. This means any improvement to the
scoring engine benefits both features.

## Code map

| File | Role |
|------|------|
| `packages/api/src/services/radio.service.ts` | Pure scoring: `scoreSimilarity` (weight-normalized), `genreCloseness`, `cosineSim`, `camelotCompatibility`, `rankCandidates`, types |
| `packages/api/src/services/radio.service.test.ts` | Unit tests for scoring logic |
| `packages/api/src/services/embedding-store.ts` | `loadEmbeddings` / `embeddingModelFor` — pooled read of cached Essentia vectors |
| `packages/api/src/routes/radio.ts` | `/api/radio/next` route + candidate pool queries (incl. `longestGenreToken`) |
| `packages/api/src/routes/radio.test.ts` | Route tests |
| `packages/api/src/routes/library.ts` | `/songs/:id/similar` refactored to use shared scorer |
| `packages/web/src/app/services/api/library-api.service.ts` | `getRadioNext()` API method |
| `packages/web/src/app/components/layout/layout.component.ts` | Smart RadioProvider registration |
