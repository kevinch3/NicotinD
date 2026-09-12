# Genre affinity — a learned genre axis for radio (spike)

**Status: shipped as a spike, not yet scoring.** The centroids are built and
refreshed daily, the pure affinity and the scoring seam exist, and the
diagnostics can A/B it against real radio output — but no route passes the
resolver yet, so `RADIO_FORMULA_VERSION` stays at 8 and radio serves exactly
what it served before. Wiring it in (formula v9) is the follow-up, once the
measurements below say the priors are right.

## The problem

Radio's genre axis ([radio.md](radio.md) "Scoring algorithm") is **lexical**:
exact name = 1.0, one token-set contained in the other = 0.6, else Jaccard ×
0.5, and `genreSetCloseness` takes the MAX over every pair of the two genre
sets. That is a fine rule for a well-tagged pop library and a bad one for any
scene with sub-genres:

1. **A shared umbrella tag masks a specific mismatch.** "Electronic; Tech
   House" against "Electronic; Big Room" is a perfect 1.0 — the MAX lands on
   "Electronic" — so a tech-house session drifts into big-room EDM, a
   transition no DJ (and no Spotify radio) would make. The same is true of
   "Latin", "Rock", "Pop" over their sub-genres.
2. **Adjacent scenes score zero.** "Tech House" vs "Minimal Techno" share no
   token, so the axis calls them as far apart as "Tech House" and "Tango".

Neither can be fixed by a weight: the axis is heavy (18 of ~66) precisely so a
right genre leads, and both failures are the axis being *confidently wrong*.

## The model: the one the library already runs

The obvious fix is a language model that knows genre relationships; the
efficient one is to not need it. Every analysed track carries a
**discogs-effnet embedding** (`library_embeddings`, 1280-d, see
[audio-ml-enrichment.md](audio-ml-enrichment.md)) — an open-weight
music-classification model that already places "Tech House" tracks near
"Minimal Techno" tracks and away from "Big Room" ones _in this library_.
So a genre **name** is summarised as the **centroid** of the tracks wearing
it, and two names are as close as their centroids' cosine. It is a
measurement of how the library's own tracks sound, not an opinion about
genre taxonomy, it costs nothing to build or refresh, and it needs no API.

The umbrella problem has its own signal in the same data. Each member vector
is L2-normalised before it is added, so the norm of the mean is the mean
cosine of the members to their centroid — **coherence**, in (0, 1]. A tag
whose members agree ("Chacarera") sits near 1; a catch-all whose members
span ambient and festival bangers ("Electronic") sits low. A match on a
low-coherence tag is discounted, so a shared umbrella can no longer beat a
real neighbour.

## Data: `library_genre_centroids`

| column        | meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `genre_key`   | `genreKey(genre)` — case/whitespace-folded join key ([genre-model.md](genre-model.md))  |
| `genre`       | display spelling (first seen)                                                           |
| `model`       | embedding model; only same-model centroids compare                                      |
| `vec`         | L2-normalised mean of the members' unit vectors (little-endian Float32 BLOB)            |
| `members`     | analysed, eligible tracks carrying the tag                                              |
| `coherence`   | \|mean of unit vectors\| — the umbrella signal                                          |
| `computed_at` | rebuild timestamp                                                                       |

`computeGenreCentroids` (`services/genre-centroids.ts`) is **one pass**: every
`library_embeddings` row under the library's dominant model
(`dominantEmbeddingModel`), joined to its song, filtered by the shared feed
predicate at tier 2 (hidden song/album out; an embedded track is analysed by
definition, and a bpm the analyser gave up on must not drop a good vector),
with the same `file_size` content check `loadEmbeddings` uses (#258). Each
vector is normalised once and added to every real genre it carries
(`library_song_genres` ∪ `library_songs.genre`, junk dropped by
`isRealGenre`). The rebuild is delete-all + insert inside one transaction, so
readers never see a half table.

**Refresh** is the marker-guarded daily sweep `maybeRunDailyGenreCentroids`,
called from the top of `LibraryProcessingService.tick()` next to the orphan
prune and the backup — same placement rationale: a derived table must not
depend on enrichment being enabled. A fresh install has no marker, so its
first tick builds the table. `genre-affinity.ts --refresh` rebuilds on demand.

## Scoring: `services/genre-affinity.ts` (pure)

`explainGenrePair(a, b, centroids)` → `{ affinity, source, cosine, credit,
members, coherence }`; `makeGenreAffinity(centroids)` is the scorer-facing
`GenreAffinityFn = (a, b) => number | null`.

- **Exact key** → `breadthCredit(centroid)` (an umbrella exact match is a weak
  claim); an exact match nobody has a centroid for keeps the lexical 1.0.
- **Both known, same model** →
  `rescaleCosine(cos) × min(breadthCredit(a), breadthCredit(b))`.
- **A side unknown or below `MIN_MEMBERS`** → `null`, and `genreSetCloseness`
  falls back to the lexical rule _for that pair_.

Constants (all priors until the measurements section says otherwise):

| constant                          | value     | role                                                                                                                                 |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `MIN_MEMBERS`                     | 5         | a centroid over fewer tracks is noise; lexical is a better guess                                                                     |
| `COS_FLOOR`                       | 0.6       | `rescaleCosine = (cos − floor) / (1 − floor)`, clamped — effnet cosines cluster high, so the floor is where "unrelated" starts       |
| `BREADTH_DISCOUNT`                | 0.5       | `credit = 1 − D × (1 − coherenceNorm)`: the most diffuse tag keeps half credit, enough to clear `MISSING_GENRE_FLOOR` on an exact match |
| `COHERENCE_LOW` / `COHERENCE_HIGH` | 0.55 / 0.9 | the band `coherenceNorm` maps onto `[0, 1]`                                                                                          |

Worked example with the reported failure (stub numbers): seed
"Electronic; Tech House". Candidate "Electronic; Big Room": best pair is the
shared "Electronic", exact but coherence-discounted → 0.5. Candidate
"Minimal Techno": the centroid pair with "Tech House" → 0.9. The neighbour
wins the axis; lexically the umbrella candidate won it 1.0 to 0. Pinned as a
regression test in `radio.service.test.ts` ("genre affinity seam").

### The seam

`explainSimilarity(seed, candidate, weights, ctx)` and `scoreSimilarity` take a
`ScoringContext { genreAffinity? }`; `rankCandidates` takes `genreAffinity` in
its options; `genreSetCloseness(a, b, affinity?)` consults it per pair.
`buildSeedRadio` / `buildListRadio` accept `genreAffinity` and echo it on
`RadioResult` so a later `explainSimilarity` over the result (poll
snapshots, the dump) scores the axis the same way. Filter radio (stations)
is untouched: it already replaces the genre axis with graded membership.
Without the option every one of these is byte-for-byte the lexical behaviour.

## Diagnostics — judge it before it plays

```bash
# rebuild now; print the coherence ranking + vocab-wide cosine percentiles
bun run packages/api/src/scripts/genre-affinity.ts --refresh
# one pair, with the breakdown
bun run packages/api/src/scripts/genre-affinity.ts --pair "Tech House" "Tango"
# what radio would drift into from here
bun run packages/api/src/scripts/genre-affinity.ts --neighbours "Tech House" --limit 20
# which tags read as umbrellas (lowest coherence first)
bun run packages/api/src/scripts/genre-affinity.ts --breadth
# the A/B against real radio output: same seed, with and without the axis
bun run packages/api/src/scripts/dump-radio.ts --seed <id>
bun run packages/api/src/scripts/dump-radio.ts --seed <id> --genre-affinity
```

What to check, in order:

1. `--breadth`: "Electronic", "Pop", "Rock", "Latin" should sit at the bottom
   (lowest coherence) and leaf styles at the top. If they do not, the
   coherence band (`COHERENCE_LOW/HIGH`) is wrong for this model.
2. `--refresh` prints p10/p50/p90 of every pairwise centroid cosine.
   `COS_FLOOR` should sit near p10: only the genuinely far pairs at zero.
3. `--neighbours "Tech House"`: techno/house neighbours above EDM/Big Room,
   "Tango" nowhere near the top.
4. The dump A/B on a tech-house seed and on two control seeds (a well-tagged
   pop seed, a folclore seed): the served window should change on the first
   and barely on the controls.

## Measurements

_None yet — fill in from the steps above on the real library before wiring
the routes. Record the model, member/centroid counts, the three percentiles,
the top and bottom of the coherence ranking, and the ranked diff per seed._

## What this is not

- **Not a taxonomy.** "Tech House ⊂ House ⊂ Electronic" is never stated; it
  emerges (or not) from where the tracks sit. A genre with no analysed
  tracks has no centroid and stays lexical.
- **Not a replacement for the embedding axis.** That axis compares the two
  _tracks_; this one compares their _tags_, which matters because most of a
  pool is scored on tags and the tag axis is the heavy one.
- **Not an LLM.** A language model would bring world knowledge for tags
  with too few tracks (`MIN_MEMBERS`); that is a possible second source
  behind the same `GenreAffinityFn` seam, deliberately not built until this
  one is measured.

## Code map

| File                                                   | Role                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `packages/api/src/services/genre-affinity.ts`          | Pure: `explainGenrePair`, `makeGenreAffinity`, `rankNeighbours`, `breadthCredit`, the constants |
| `packages/api/src/services/genre-centroids.ts`         | IO: `computeGenreCentroids`, `loadGenreCentroids`, `loadGenreAffinity`, `listGenreCentroids`, `maybeRunDailyGenreCentroids` |
| `packages/api/src/scripts/genre-affinity.ts`           | The diagnostic above (`--refresh` is its one write)                                     |
| `packages/api/src/scripts/dump-radio.ts`               | `--genre-affinity` A/B flag                                                             |
| `packages/api/src/services/radio.service.ts`           | `ScoringContext`, the `genreSetCloseness` / `rankCandidates` seam                       |
| `packages/api/src/db.ts`                               | `library_genre_centroids`                                                               |
