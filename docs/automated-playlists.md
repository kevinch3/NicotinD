# Automated playlists — strategy & build guide

**Status: shipped (deterministic core).** Recipe-driven, weekly-refreshed shelves
now exist and materialize into `kind='curated'` playlists that appear in
"Made for you" unchanged. The broader vision and metadata mapping live in
[playlist-generation.md](playlist-generation.md); the ML features that feed
richer recipes shipped too ([audio-ml-enrichment.md](audio-ml-enrichment.md)).
The optional **LLM concept layer (§7) was dropped** — the user chose pure audio
analysis; recipes consume the perceptual columns directly.

## What shipped (code map)

| Piece | Location |
| --- | --- |
| `PlaylistRecipe` type + `RECIPES` array (Late Night / Workout / Fresh This Week / Harmonic Electronic + the perceptual shelves Mellow Acoustic / Instrumental Focus / Feel Good / Late Night Unwind) | `services/playlist-recipe.ts` |
| Pure `runRecipe` / `orderTracks` (incl. `harmonic` Camelot+BPM+energy chaining and the `energy-arc` ramp) / `weekSeedFor` / `slugSeed` / `seedCentroid` | `services/playlist-recipe.ts` |
| `refreshAutoPlaylists(db, now, {apply})` + shared idempotent `upsertCuratedPlaylist` + weekly guard `maybeRefreshAutoPlaylists` | `services/auto-playlists.service.ts` |
| In-process weekly guard hook (once per ISO week, inside the maintenance window) | `services/library-processing.service.ts` `tick()` |
| Ops/first-rollout script (dry-run default, `--apply`) | `scripts/refresh-auto-playlists.ts` |
| Covers for recipe slugs (same generator as curated) | `scripts/generate-playlist-covers.ts` |

The `harmonic` order reuses `camelotCompatibility` from `radio.service.ts` (the
Radio scorer) rather than duplicating wheel logic, and `runRecipe` reuses
`selectCuratedTracks` (seeded shuffle + per-artist cap). The weekly guard stores
its marker in `library_sync_state` under `auto_playlists_week`.

**Zero-candidate recipes don't create shelves**: a recipe whose `where` matches
nothing (the perceptual shelves before the enrichment backfill has run) is
skipped rather than materialized empty. An already-materialized shelf still
updates — even down to empty — so tracks that left the library drain out.

## Original build guide (retained for the design rationale)

## Strategy

**An automated playlist is a `recipe` that the system materializes into a
`kind='curated'` playlist and re-runs on a schedule.** Three principles:

1. **The catalogue is the source of truth.** A recipe only *selects and orders*
   tracks that already exist (no invented IDs). Everything is SQL over
   `library_songs` + the enrichment columns (`genre`, `bpm`, `key`, `year`,
   `duration`, …) we already fill in the windowed processor.
2. **Deterministic + reproducible.** Selection uses the existing seeded shuffle
   (`mulberry32` → `seededShuffle`) + per-artist cap, so a given (recipe, seed)
   always yields the same list. A **week-derived seed** makes the set rotate weekly
   while staying reproducible/debuggable.
3. **Reuse curated-playlist infra, don't reinvent.** The data model
   (`playlists.kind='curated'` + `cover_art`, global & read-only via the per-user
   API), the selector (`selectCuratedTracks`), the gradient covers
   (`playlistCoverSvg`), and the idempotent seed (match by `(kind='curated',
   name)`) already exist. Automation generalizes the **definition** + adds a
   **scheduler**.

The only genuinely new pieces are: a richer **recipe** type (filter + sort +
size + cadence), a **recipe runner**, and a **weekly refresh job**.

## What already exists (reuse these)

| Piece | Location |
| --- | --- |
| `CuratedPlaylistDef` (slug/name/description/palette/`where`/targetSize/maxPerArtist) | `services/curated-playlists.ts` |
| `selectCuratedTracks(rows, {targetSize, maxPerArtist, seed})` — seeded shuffle + per-artist cap | `services/curated-playlists.ts` |
| Gradient SVG cover builder `playlistCoverSvg` | `services/playlist-cover.ts` |
| Idempotent seeding (upsert by `(kind,name)`, `DELETE+reinsert playlist_songs`) | `scripts/seed-curated-playlists.ts` |
| `playlists.kind`/`cover_art`; curated = global + read-only | `db.ts`, `services/playlist.service.ts` |
| Harmonic ordering helper `keyToCamelot` | `services/key-detection.ts` |

## Steps to follow

### 1. Generalize the recipe definition
Extend `CuratedPlaylistDef` into a `PlaylistRecipe` (or add fields) so a recipe
fully describes itself:

```ts
interface PlaylistRecipe extends CuratedPlaylistDef {
  // existing: slug, name, description, palette, where, targetSize, maxPerArtist
  sort?: 'shuffle' | 'bpm' | 'year' | 'newest' | 'harmonic'; // default 'shuffle'
  cadence?: 'weekly' | 'static';     // weekly → reseed each week; static → seed once
  minPending?: never;                // recipes are pure SQL; no analysis at runtime
}
```

Keep `where` a **pure SQL fragment over alias `s`** (`library_songs s`) — the same
contract curated playlists use — so recipes stay declarative and SQL-injection-free
(they're code-defined, not user input).

### 2. Author the recipes
Add a `RECIPES: PlaylistRecipe[]` array (next to `CURATED_PLAYLISTS`). Examples
straight from existing columns:

```ts
{ slug:'late-night', name:'Late Night', where:"s.bpm BETWEEN 60 AND 95",
  sort:'bpm', targetSize:40, maxPerArtist:2, cadence:'weekly', palette:'indigo' }
{ slug:'90s-rock', name:'90s Rock', where:"s.genre LIKE '%rock%' AND s.year BETWEEN 1990 AND 1999",
  targetSize:50, maxPerArtist:3, cadence:'weekly', palette:'amber' }
{ slug:'workout', name:'Workout', where:"s.bpm BETWEEN 125 AND 140",
  sort:'harmonic', targetSize:40, maxPerArtist:2, cadence:'weekly', palette:'rose' }
{ slug:'fresh', name:'Fresh This Week', where:"1=1", sort:'newest',
  targetSize:30, maxPerArtist:2, cadence:'weekly', palette:'teal' }
```

### 3. Build the recipe runner (pure, testable)
A function that turns a recipe + candidate rows into an ordered track-id list:

```ts
function runRecipe(recipe, rows, weekSeed): string[] {
  const picked = selectCuratedTracks(rows, {
    targetSize: recipe.targetSize, maxPerArtist: recipe.maxPerArtist,
    seed: recipe.cadence === 'weekly' ? weekSeed : 1,
  });
  return orderTracks(picked, recipe.sort); // shuffle|bpm|year|newest|harmonic
}
```

- `orderTracks` is pure: `bpm`/`year`/`newest` are sorts; **`harmonic`** chains by
  Camelot adjacency (`keyToCamelot`) + nearest BPM (the DJ-mix ordering from
  playlist-generation.md §2c).
- `weekSeed = ISO-week number` (e.g. `floor(epochDays/7)`), so the set rotates
  weekly and is reproducible.
- The candidate rows come from one query per recipe: `SELECT … FROM library_songs s
  WHERE s.hidden=0 AND (<recipe.where>)`.

Keep `runRecipe`/`orderTracks` **DI-free and unit-tested** — they're the core logic.

### 4. Materialize via the idempotent seed path
Reuse `seed-curated-playlists.ts`'s upsert exactly: for each recipe, match the
existing curated playlist by `(kind='curated', name)`, `DELETE` its
`playlist_songs`, and re-insert the new ordered ids (positions 0..n). Generate/refresh
the cover via `playlistCoverSvg(recipe.palette, recipe.name)`. This makes a refresh
**idempotent and atomic per playlist** — no duplicates, stable URLs.

### 5. Add the scheduler (the "automated" part)
Two options; pick by how the server is run:

- **Preferred — a weekly cloud routine** via `CronCreate` (the `/schedule` skill):
  one routine that runs `bun run scripts/refresh-auto-playlists.ts --apply` weekly
  (e.g. Mondays 05:00, inside the existing maintenance window).
- **In-process alternative** — a tick in the windowed processor that, once per ISO
  week (guard on a `library_sync_state` marker like `auto_playlists_week=<n>`), runs
  the refresh. Reuses the existing scheduler; no external cron.

Either way the job is the same: load recipes → query candidates → `runRecipe` →
idempotent upsert. Make it **dry-run unless `--apply`** like the other scripts.

### 6. Surface in the UI (already handled)
Auto playlists are `kind='curated'`, so the **"Made for you"** shelf and the curated
badge/read-only behavior in the web work with **zero UI changes** — they appear the
moment they're seeded.

### 7. (Optional) LLM concept layer
Once recipes work, add a weekly LLM pass that proposes *new* recipe concepts as
**structured filters** (not track lists) from a library summary, names/blurbs them,
and the deterministic runner fills them. Validate every LLM-proposed `where`/sort
against the recipe schema before running it. See playlist-generation.md §3.

## Testing (do these alongside each step)

- **`runRecipe` / `orderTracks` (pure, CI)** — seed determinism (same week ⇒ same
  list; next week ⇒ different but reproducible); `maxPerArtist` respected; `harmonic`
  produces Camelot-adjacent neighbours; empty candidate set ⇒ empty (no crash).
- **Recipe `where` validity** — a test that runs every recipe's query against a
  seeded in-memory library so a malformed fragment fails CI, not prod.
- **Idempotency** — seed twice ⇒ one playlist, no duplicate `playlist_songs`, stable
  id; a track that left the library is dropped (mirrors the existing curated test).
- **Scheduler guard** — the week-marker prevents a double refresh within one week.

## Rollout order

1. Recipe type + 4–6 starter recipes + `runRecipe`/`orderTracks` (+ tests).
2. `scripts/refresh-auto-playlists.ts` reusing the curated upsert (dry-run default).
3. Run once `--apply`; verify they appear in "Made for you".
4. Schedule weekly (CronCreate routine or the in-process week-guard).
5. Harmonic ordering once `key` backfill completes (it's filling now).
6. Optional LLM concept layer.

→ Strategy/feature context: [playlist-generation.md](playlist-generation.md);
richer inputs: [audio-ml-enrichment.md](audio-ml-enrichment.md); the enrichment that
feeds recipes: [library-processing.md](library-processing.md).
