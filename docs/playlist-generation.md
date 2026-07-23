# Metadata-driven playlist generation (weekly, with or without an LLM)

**Status: the deterministic core is shipped** (see
[automated-playlists.md](automated-playlists.md) for the code map). One lane is
live today, reusing the Radio scorer + curated selection engines:
1. **Automated system shelves** — recipe → weekly-refreshed `kind='curated'`
   playlists (§2a), refreshed in-process once per ISO week.

**The user-driven seed generator described below no longer exists.**
`POST /api/playlists/generate` (fill an editable `kind='user'` playlist from a
song/artist/starred-set seed via `rankCandidates` + harmonic ordering), the
artist-page "✨ Generate playlist" button, and the playlists-tab "Generate from
your favorites" button were all removed — the manual, search-driven path
below replaced them as the way a user builds up a playlist's contents. The
underlying `rankCandidates`/`orderTracks` engines were **not** deleted; they're
still live shared infra behind `/api/radio/*` (§2b/§2c below still describes
real, current behavior) and `playlist-recipe.ts`'s recipe/ordering functions
still back §2a's automated shelves.

**What replaced it — search + suggest, not auto-fill.** A playlist's detail
page now offers a debounced song-search picker (`SongPickerComponent` over
`GET /api/library/songs/autocomplete`) to add specific tracks by hand, plus a
"Suggested for this playlist" list (`GET /api/playlists/:id/proposals`) of
cheap token-overlap candidates the user can add with one click. Full design in §0 "Manual playlist building — search + proposals" below; this
is deliberately not a "generate the whole playlist for me" feature
— it never invents a full tracklist from one seed, only makes finding
individual tracks fast.

The remainder is the original design note. It explains how NicotinD's **existing
per-track metadata** — plus the enrichment we fill in the background (BPM, genre,
musical key) — generates Spotify-style playlists using light, deterministic
algorithms, and where an LLM helps (and where it must *not* be trusted). The
**LLM concept layer (§3) is not yet built** — it remains the documented
follow-up.

The north star: **the catalogue is the source of truth; algorithms only select
and order tracks that already exist.** Nothing here should invent track IDs.

---

## 0. Manual playlist building — search + proposals

The current, live way a user fills a playlist's contents (replaces the removed
seed generator above). Two backend endpoints in
`packages/api/src/services/playlist.service.ts` /
`packages/api/src/routes/playlists.ts` and `routes/library.ts`; one shared web
component:

- **`GET /api/library/songs/autocomplete?q=&limit=`** (`routes/library.ts`,
  registered ahead of `/songs/:id` so the literal `autocomplete` path segment
  is never shadowed by the param route) — tokenizes the query with
  `tokenize()` from **`search-tokens.ts`** (the same accent-folding,
  multi-token AND matcher used by the main library search — see
  [library-scanner.md](library-scanner.md) "Search matching") and filters
  landed, non-hidden songs whose `title + artist + album` matches every
  token. Capped at `limit` (default 8, max 25). Backs the web
  `SongPickerComponent` (`components/song-picker/`), a reusable,
  playlist-agnostic picker (songs + an `excludeIds` filter) that debounces
  input 250ms (`setTimeout`/`clearTimeout`, matching the Library Songs tab's
  own convention rather than an rxjs debounce operator) before calling
  `LibraryApiService.searchSongsAutocomplete`. The playlist detail page feeds
  it `playlistTrackIds()` as `excludeIds` so already-added tracks never show
  as a duplicate pick, and emits `add` back up to `PlaylistDetailComponent`.

- **`GET /api/playlists/:id/proposals?limit=`** (`PlaylistService.proposals`)
  — cheap, non-ML "suggested for this playlist" candidates, using the same
  `search-tokens.ts` primitive (`tokenize`/`matchesAllTokens`/`rankBy`) as the
  autocomplete above. The visibility guard matches `get()`: a curated
  playlist is readable by any user, a user playlist only by its owner (`null`
  otherwise → route 404s). **Token source is a strict two-branch choice, not
  a blend**:
  - **Empty playlist** → tokens come from the playlist's own **name** (e.g.
    "90s Rock Anthems" → `rock`/`anthems`).
  - **Non-empty playlist** (≥1 track) → tokens come only from the
    **titles/artists already in it**; the playlist's name is never read
    again once it holds a track.

  This is deliberate, not an oversight: a playlist's name can drift out of
  sync with its contents once it's been renamed after the fact (see the
  merged-list rename UI below), while its actual tracks are ground truth for
  what it's about — so track-derived tokens win the moment there's any
  ground truth to derive them from. Matching candidates (excluding songs
  already in the playlist) are ranked by `rankBy(tokens, title)` and capped
  at `limit` (default 20). `PlaylistDetailComponent.refreshProposals()`
  re-fetches after every membership-changing mutation (`addSong`,
  `removeSong`, bulk remove, and the initial load) via
  `PlaylistService.getProposals` (thin passthrough, no client-side caching),
  so the list stays current without a dedicated poll.

This is intentionally **not** an auto-fill feature — it never invents a whole
tracklist from one seed the way the removed generator did. It only makes
finding and adding individual matching tracks fast, and nudges the user
toward tracks that already look like they belong.

**e2e coverage** (`packages/e2e/tests/playlists.spec.ts`, replacing the
deleted `playlist-generate.spec.ts`): one flow drives create → picker →
proposals → merged-list rename → delete end to end. The proposals step needs
a genuine token overlap, not just visually-similar fixture titles — the
fixture set (`scripts/make-fixtures.ts`, `FIXTURE.proposalPair` in
`helpers.ts`) adds a same-artist pair sharing a title token ("Nocturne" /
"Nocturne Drift"): adding the first seeds proposal tokens
`{nocturne, e2e, playlist, seed, artist}`, all of which are substrings of the
second's `title + artist`, so `matchesAllTokens` genuinely surfaces it rather
than the match being incidental.

## 0a. Merged playlist list (single list, inline rename/delete)

The Library page's Playlists mode (`library.component.ts`/`.html`,
`data-testid="playlists-list"`) shows **one** list rather than separate
"yours" / "curated" sections — `PlaylistService.list()` already returns the
user's own playlists plus every global `kind='curated'` playlist sorted
server-side (curated first, then by `modified_at` — see
`PlaylistService.list` in `playlist.service.ts`), so the client renders it
verbatim with no re-sort/split. Each row (`data-testid="playlist-row"`)
shows a small inline **"Curated"** badge (`data-testid="curated-badge-inline"`)
for `kind === 'curated'` rows instead of a separate shelf. Only `kind ===
'user'` rows get the per-row **Rename** (`data-testid="rename-playlist"`,
inline text input, commit on Enter/blur, cancel on Escape) and **Delete**
(`data-testid="delete-playlist"`, confirm dialog, `kind='curated'` guarded
server-side too) icon buttons — a curated row is read-only by `kind`, not by
ownership, matching [curated-playlists.md](curated-playlists.md)'s "read-only
by kind" convention. Creating a playlist (name input + submit) navigates
straight to the new playlist's detail route (`create()` → `router.navigate`)
rather than staying on the list, since the next thing a user does after
creating one is almost always add songs to it via §0 above.

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

### 2b. Similarity ("more like this") via a feature vector — ✅ realized

Shipped as the shared Radio scorer (`scoreSimilarity` / `rankCandidates` in
`radio.service.ts`), used by `/api/radio/next` and `/songs/:id/similar` (the
now-removed `POST /api/playlists/generate` was a third consumer of this same
engine — see §0 above for what replaced it). Two refinements landed on top of
the original scalar blend:

- **Weight-normalized blend, not a raw sum.** Each factor counts only when both
  tracks carry it; the score is `Σ(factorScore×weight) / Σ(weight of comparable
  factors)` → `0..1`. So a mid-backfill library isn't biased toward the
  already-enriched slice (un-analyzed tracks compete on the factors they have).
- **The cached Essentia embedding is now a real similarity axis.** `cosineSim`
  over `library_embeddings` vectors (loaded per-pool by `loadEmbeddings`) is added
  as an augment closeness term — the vector distance §2b originally proposed,
  reusing the embedding we already cache. Genre matching is softened lexically
  (`genreCloseness`: case-fold + token-set containment/overlap) rather than
  exact-string, and the candidate pools were widened with a genre-`LIKE` pass so
  variants are actually considered.

A seed track (or a starred set's / artist's centroid — `seedCentroid`, plus a
mean seed embedding) → a coherent playlist. Pure, unit-tested, in-memory over the
candidate pool.

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
