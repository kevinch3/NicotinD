# Metadata-driven playlist generation (weekly, with or without an LLM)

**Status: the deterministic core is shipped** (see
[automated-playlists.md](automated-playlists.md) for the code map). Two lanes now
exist, both reusing the Radio scorer + curated selection engines:
1. **Automated system shelves** — recipe → weekly-refreshed `kind='curated'`
   playlists (§2a), refreshed in-process once per ISO week.
2. **User-driven seed generator** — `POST /api/playlists/generate` fills an
   editable `kind='user'` playlist from a song / artist / starred-set seed using
   `rankCandidates` (the Radio scorer) + harmonic ordering (§2b/§2c). Surfaced in
   the web via "✨ Generate playlist" on the artist page and "Generate from your
   favorites" in the playlists tab.

The remainder is the original design note. It explains how NicotinD's **existing
per-track metadata** — plus the enrichment we fill in the background (BPM, genre,
musical key) — generates Spotify-style playlists using light, deterministic
algorithms, and where an LLM helps (and where it must *not* be trusted). The
**LLM concept layer (§3) is not yet built** — it remains the documented
follow-up.

The north star: **the catalogue is the source of truth; algorithms only select
and order tracks that already exist.** Nothing here should invent track IDs.

---

## 1. What metadata we have (and where it comes from)

Already in `library_songs` / side-tables today:

| Field | Source | Notes |
| --- | --- | --- |
| `genre` | tag / Lidarr (windowed genre task) | categorical, sometimes multi |
| `bpm` | tag / `analyzeBpm` (windowed bpm task) | numeric |
| `key` | tag / `analyzeKey` (windowed key task) | "C major" → Camelot via `keyToCamelot` |
| `year` | tag / Lidarr | era bucketing |
| `artist`, `album`, `artist_id`, `album_id` | scanner | dedup / per-artist caps |
| `duration` | scanner (`format.duration`) | playlist length budgeting |
| `starred` (per user) | user action | personalization signal |
| `classification` (album/ep/single/…) | `LibraryCurator` | filter scope |
| acquisition method / date | `acquisitions` | "recently added" |

All of it is **cheap to read** and already indexed. The windowed processor
(`library-processing.service.ts`) is what keeps `bpm`/`genre`/`key` filled for new
downloads, so the feature set below stays dense over time.

---

## 2. Without an LLM — light, deterministic recipes

This is the bulk of the value and needs **zero** external calls. Three layers:

### 2a. Recipes (the curated-playlist pattern, generalized)

The existing curated playlists already do this: `services/curated-playlists.ts`
`selectCuratedTracks` does a **seeded shuffle + per-artist cap** over a filtered
candidate set, and `playlist-cover.ts` builds a gradient SVG cover. A generic
"auto-playlist" is just a **recipe** = a SQL-expressible predicate + a sort + the
existing selector:

```
recipe = {
  name, filter (WHERE …), sort, size, perArtistCap, seed
}
```

Examples that fall straight out of the columns:

- **"90s Rock"** — `genre LIKE '%rock%' AND year BETWEEN 1990 AND 1999`.
- **"Late-night low-BPM"** — `bpm BETWEEN 60 AND 95`, sort by bpm.
- **"High-energy workout"** — `bpm BETWEEN 125 AND 140`, genre in a dance/electronic set.
- **"Fresh this week"** — newest by `acquisitions.acquired_at`.
- **"Rediscover"** — not played recently / not starred, seeded random.

These reuse `selectCuratedTracks` verbatim. A weekly job (a `CronCreate` routine, or
another windowed task) re-runs the recipes with a **week-derived seed** so the set
rotates deterministically but feels fresh, and writes them as `kind='curated'`
playlists via the existing idempotent `seed-curated-playlists.ts` path.

### 2b. Similarity ("more like this") via a feature vector

Build a small per-track vector and use plain distance — no ML framework:

- **Numeric, normalized 0..1**: bpm (e.g. `/ 200`), year (min-max over library),
  duration.
- **Categorical**: genre (one-hot over the top-N genres, or a hand-grouped
  super-genre map), key.
- **Distance**: weighted Euclidean / cosine. "Tracks like X" = nearest neighbours.

A seed track (or a starred set's centroid) → a coherent playlist. This is a few
dozen lines, pure, unit-testable, and runs in-memory over ~thousands of rows.

### 2c. Harmonic / energy *ordering* (DJ-style sequencing)

Independent of *selection*: once you have a track set, **order** it so adjacent
tracks mix well — the payoff of the new `key` data:

- **Camelot adjacency**: `keyToCamelot` gives "8A/8B" codes; compatible moves are
  same code, ±1 number, or A↔B swap. Greedily chain tracks by compatible key.
- **BPM proximity**: prefer the next track within ±5–8% BPM.
- **Energy arc**: ✅ shipped — `orderTracks('energy-arc')` builds a ramp-up →
  peak → ramp-down over `energy`, and `harmonicChain` adds an energy-closeness
  term (0-neutral when either side is un-analyzed).

This turns a flat list into a set that flows like a DJ mix — a real differentiator
over genre-only playlists.

### 2d. Clustering (themes the library *actually* has)

Run simple k-means (or even just group-by super-genre × era × bpm-band) over the
feature vectors to discover the natural clusters in *this* library, then name the
biggest ones. No LLM needed to *form* the groups — only (optionally) to name them.

---

## 3. With an LLM — concept & language, never track selection

Use the LLM where it's genuinely better and **cheap/safe**, run weekly and cached:

- **Theme/concept generation (grounded)**: feed the LLM a *summary* of the library
  (top genres, era histogram, bpm distribution, notable artists) and ask for a list
  of playlist **concepts as structured selection criteria** — `{name, description,
  filter, target_bpm_range, era, vibe}` — **not** track lists. The deterministic
  engine in §2 then *fills* each concept. The LLM proposes the idea; the catalogue
  guarantees the tracks exist. This is the key pattern: **LLM emits filters, code
  picks tracks** → no hallucinated songs, tiny token cost.
- **Naming & blurbs**: titles, one-line descriptions, and cover-gradient prompts for
  playlists the deterministic clusterer found.
- **Mood/vibe labelling** (a per-track enrichment task, §4): an LLM (or a small
  audio model) assigns a `mood` tag from features; that label then feeds §2 recipes
  ("Melancholy evening"). Do this as a batched windowed task, cached on the track.

Guardrails: weekly cadence + cache results; send aggregates, not the whole library;
validate every LLM-proposed filter against the schema before running it; if the LLM
is unavailable, §2 still produces playlists (graceful degradation, same posture as
the rest of the app). Use the latest Claude model for these calls.

---

## 4. Metadata roadmap → enrichment tasks

The richer the per-track metadata, the better §2/§3 get. Everything below is just
**another `EnrichmentTask`** appended to `ENRICHMENT_TASKS` (same column + scan-read
+ windowed-fill pattern as bpm/genre/key — see docs/library-processing.md). Grouped
by how we'd get it:

**Tag-readable (cheap, no analysis)** — surface from `music-metadata`/ffprobe at scan
time. *Status today:* the scanner (`MMFormat`) captures only **duration, bitrate,
container, codec** (stored as `duration`/`bit_rate`/`suffix`/`content_type`) plus the
embedded text tags (title/artist/album/year/track + the enriched genre/bpm/key). The
rest below are **readable but not yet captured/stored** — each needs a column + a
scan-read line (the cheapest items on this roadmap, no DSP):
- **Not captured yet**: sample rate, bit depth, channel count (extend `MMFormat` +
  `library_songs`), comment field.
- **Not captured yet**: loudness-normalization data (ReplayGain tags), time signature
  (`TIME`/tag) when present.

**Offline DSP (ffmpeg decode + pure JS, like bpm/key)** — no external service:
- **Key / harmonic key** — ✅ shipped (`key-detection.ts`).
- **Loudness + energy** — ✅ shipped (`loudness-analysis.ts`): integrated LUFS +
  loudness range via ffmpeg `ebur128`, energy derived from both; the `energy`
  enrichment task + `scripts/analyze-energy.ts` fill `library_songs.energy`/
  `loudness` and the `ENERGY`/`LOUDNESS_LUFS` file tags.
- **Tempo variation over time** — windowed `analyzeBpm` over segments → stability score.
- **Time signature** — autocorrelation of the onset envelope (moderate effort).

**Model-assisted (local audio models — no LLM, per the dropped-scope decision in
[audio-ml-enrichment.md](audio-ml-enrichment.md))**:
- **Valence / danceability / mood / acousticness / instrumentation** — ✅ shipped:
  the `audio-features` task calls the Essentia analysis sidecar
  (`packages/analysis/`), stores columns + `VALENCE`/`DANCEABILITY`/`MOOD`/…
  file tags and caches the embedding in `library_embeddings`.
- **Section markers (intro/verse/chorus/drop)** — structural segmentation; the
  heaviest item, a dedicated model. Useful later for smart previews/transitions.

Recommended order (value ÷ effort): **energy → loudness/dynamic-range → tempo
variation → mood/valence/danceability → instrumentation/vocal-presence → time
signature → section markers.** Each one slots into the existing windowed processor
and immediately enriches the playlist recipes and harmonic ordering above.

---

## 5. Suggested build path

1. **Generalize the recipe layer**: factor `selectCuratedTracks` into a reusable
   "recipe → playlist" function; express 8–12 recipes from current columns (§2a).
2. **Weekly refresh job**: a `CronCreate` routine (or windowed job) re-seeds the
   recipe playlists with a week-derived seed; idempotent like `seed-curated-playlists.ts`.
3. **Add `energy`** as the next enrichment task — unlocks energy-arc ordering and
   better recipes for the least effort.
4. **Harmonic ordering** using `keyToCamelot` + bpm (§2c) as an optional "DJ mix"
   sort on any playlist.
5. **Optional LLM concept pass** (§3): aggregate-summary → structured concepts →
   deterministic fill → LLM names/blurbs. Weekly, cached, degrades gracefully.

This keeps the expensive/fuzzy parts (LLM, models) optional and weekly, while the
everyday experience is fast, deterministic, and fully offline.
