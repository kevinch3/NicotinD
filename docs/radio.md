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
Each factor produces a 0–1 score, multiplied by its weight:

| Factor | Logic | Default weight |
|--------|-------|----------------|
| Genre | exact match = 1.0, mismatch = 0 | 10 |
| BPM proximity | 1 − clamp(\|Δbpm\| / seedBpm × 5, 0, 1) | 8 |
| Key compatibility | Camelot wheel adjacency (same=1.0, A↔B=0.8, ±1=0.7, else 0) | 6 |
| Year proximity | 1 − clamp(\|Δyear\| / 20, 0, 1) | 2 |
| Duration similarity | 1 − clamp(\|Δdur\| / seedDur, 0, 1) | 1 |
| Artist diversity | same artist → subtract penalty | 8 |
| Energy closeness | 1 − \|Δenergy\| (both sides present, else 0) | 5 |
| Valence closeness | 1 − \|Δvalence\| (both sides present, else 0) | 4 |
| Danceability closeness | 1 − \|Δdanceability\| (both sides present, else 0) | 3 |
| Instrumentalness closeness | 1 − \|Δinstrumental\| (both sides present, else 0) | 3 |
| Acousticness closeness | 1 − \|Δacousticness\| (both sides present, else 0) | 2 |

The five perceptual axes come from the enrichment tasks (ffmpeg energy +
analysis sidecar — see [audio-ml-enrichment.md](audio-ml-enrichment.md)). A
missing value on **either** side contributes exactly 0, so an un-analyzed
library scores identically to the pre-feature scorer (pinned by test). Note
for tuning: a fully-analyzed library raises the max attainable score ~27 → ~44,
which weakens `artistPenalty` relatively — revisit weights after the first
full backfill.

### Camelot harmonic compatibility

Uses `keyToCamelot()` from `services/key-detection.ts`. Compatible moves on
the Camelot wheel:

- **Same code** (e.g. 8B→8B): perfect match (1.0)
- **Same number, different ring** (8B→8A): relative major/minor (0.8)
- **Adjacent number, same ring** (8B→7B or 9B): energy shift (0.7)
- **Everything else**: 0

### Candidate pool construction

The `/api/radio/next` endpoint builds a diverse pool in four passes:

1. Same genre as seed (up to 150 random)
2. Similar BPM range ±15% across all genres (up to 100 random)
3. Energy-adjacent ±0.15 across all genres (up to 100 random; only when the
   seed carries an energy value)
4. Random backfill if the pool is still small

The `rankCandidates` function scores all candidates, sorts by score, and
applies a per-artist cap (default 2) to prevent any single artist from
dominating the radio queue.

## API

| Method | Path | Params | Returns |
|--------|------|--------|---------|
| GET | `/api/radio/next` | `seedId` (required), `exclude` (comma-separated IDs), `count` (1–50, default 10) | `Song[]` |

## Perceptual features (shipped)

The Essentia/ffmpeg enrichment landed exactly along the planned extension
points: `SongFeatures` carries `energy`/`valence`/`danceability`/
`instrumental`/`acousticness`, `scoreSimilarity` scores them as weighted
closeness axes (table above), and the radio route + RadioProvider were
unchanged apart from the extra pool. Sequencing on top of selection lives in
`playlist-recipe.ts`: `orderTracks('energy-arc')` (ramp-up → peak → ramp-down)
and the energy term inside `harmonicChain`.

## Shared scoring with `/songs/:id/similar`

The `/songs/:id/similar` endpoint reuses the same `rankCandidates` and
`scoreSimilarity` functions with different weights (same-artist is boosted
rather than penalized, and the per-artist cap is higher). This means any
improvement to the scoring engine benefits both features.

## Code map

| File | Role |
|------|------|
| `packages/api/src/services/radio.service.ts` | Pure scoring: `scoreSimilarity`, `camelotCompatibility`, `rankCandidates`, types |
| `packages/api/src/services/radio.service.test.ts` | 17 unit tests for scoring logic |
| `packages/api/src/routes/radio.ts` | `/api/radio/next` route + candidate pool queries |
| `packages/api/src/routes/radio.test.ts` | 8 route tests |
| `packages/api/src/routes/library.ts` | `/songs/:id/similar` refactored to use shared scorer |
| `packages/web/src/app/services/api/library-api.service.ts` | `getRadioNext()` API method |
| `packages/web/src/app/components/layout/layout.component.ts` | Smart RadioProvider registration |
