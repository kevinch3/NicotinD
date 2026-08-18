# Artist origin (nationality) metadata

Standard per-artist origin countries feeding the radio matcher, the library
filter, playlist recipes, and the artist page. Design spec (pre-implementation
history): the brainstorm settled on artist-level single-country storage with a
query-time join — no denormalized song column, no per-song origin.

## Why

The radio blend was culture-blind: BPM, key and the perceptual axes carry no
notion of where music comes from, and genre tags are often too broad ("Latin",
"Pop") or missing to compensate. Observed failure: a cuarteto track (an
unmistakably Argentine genre) matched against Queen because the tempo lined
up. Artist origin is a reliably-available fact (MusicBrainz carries `country`
for most established artists) that separates musical worlds when genre can't.

## The vocabulary (`@nicotind/core` `origin.ts`)

- **Canonical value**: uppercase ISO 3166-1 alpha-2 (`AR`, `CL`, `GB`).
  `isCountryCode` validates against the real ISO list (never a shape regex);
  `normalizeMbCountry` uppercases + validates and maps MusicBrainz's special
  codes `XW` (worldwide) / `XE` (Europe) to null — they carry no matching
  signal.
- **No display names shipped**: the UI uses
  `Intl.DisplayNames(locale, { type: 'region' })`, so names localize with the
  language switch for free and core stays codes-only. Flags are
  regional-indicator emoji derived arithmetically (`countryFlagEmoji`) — zero
  assets.
- **`ORIGIN_REGIONS`** groups countries into *musical-cultural* regions
  (`rio-de-la-plata` = AR/UY/PY, `andean`, `brazil` alone, `uk-ireland`, …),
  each mapped to a super-region. Two deliberate judgment calls:
  - an **anglosphere** super-region (UK/Ireland + US/Canada + AU/NZ) models the
    shared rock-pop lineage — US↔UK scores 0.4 while AR↔GB floors at 0.1,
    which is exactly the cuarteto/Queen separation;
  - **iberia stays european** despite the language tie to Latin America; a
    cross-super affinity table could refine that later (YAGNI for now).
  The table is owner-curated data — regrouping a country (does Chile belong in
  `andean`?) is a data edit, not a code change, and `dump-radio.ts --weights`
  is the calibration instrument.
- **`originCloseness(a, b)`** tiers: same country 1.0 → same region 0.7 → same
  super-region 0.4 → **0.1 floor** (demote, never veto — two known-distant
  origins are still both music); null when either side is unknown/invalid so
  the axis is skipped, not scored. `originSetCloseness` is the max pairwise
  over credited-artist sets (the `genreSetCloseness` shape), so a collab
  matches through any of its artists.

## Storage (`library_artist_origins`)

Modeled on `library_artist_meta`:

- `artist_id` PK, `country` (NULL = tombstone), `source`
  (`musicbrainz`/`user`), `checked_at`.
- **Tombstone semantics**: a row with `country NULL` means "checked, nothing
  usable"; *no row* means "never attempted" (task retries). Unlike the bio
  tombstones, origin tombstones **re-open after `ORIGIN_RECHECK_TTL_MS`
  (30 days)** — see the livelock note below.
- **`source='user'` is permanent**: the upsert's WHERE clause refuses a
  `musicbrainz` write over a `user` row, so the background task can never
  clobber a curator decision.
- **Survives identity fixes**: `carryArtistCuration` moves the row on a
  rename/merge (artist ids re-mint from the name), never clobbering the
  destination's own — the #305 orphaned-portrait bug class.
- **No file-tag write-back** (unlike licence/bpm/genre): origin is
  artist-level and extrinsic to any one file; denormalizing into song tags
  would need reconciliation on every conflict. Follows the popularity
  precedent — extrinsic data stays DB-only, and the scanner never touches it.

## Enrichment (`artist-origin` task)

Per-artist like `artist-info`, default-on, never a landing gate (artist-scoped
tasks have no `satisfiedColumnSql`, so the gate machinery structurally can't
strand a download). One cached MB request per artist under the client's
existing 1 req/s limiter (`getArtistOrigin`: `country` field first, else a
country-typed `area`'s ISO code; new `origin` variant in the disk-cache
union).

Miss semantics (the three-way split):

| Case                                   | Action                                    |
| -------------------------------------- | ----------------------------------------- |
| No MBID (after the live Lidarr fallback) | TTL-tombstone (re-checked after 30 days) |
| MB answered, no usable country (XW/XE) | TTL-tombstone                             |
| Transient MB failure (`ok: false`)     | Nothing written — retried next window     |

**Why the TTL tombstone (a deliberate amendment to the original spec):** the
spec wanted no-MBID artists left pending forever so a later-acquired MBID
eventually fills them — but `run` takes the top-N pending per window, so a
block of unresolvable artists would occupy the batch every run and starve the
resolvable ones behind them (a livelock). The TTL keeps the spec's intent
(re-attempt once a month, when `library_mbids` may have grown) without the
stall. Mirrors `ARTIST_IDENTITY_TTL_MS`.

`scripts/backfill-artist-origins.ts` is the bulk one-shot (dry-run by default,
`--apply` to write) so an existing library fills in one run instead of
trickling through daily windows; it drives the same `artistOriginTask.run`, so
script and task cannot drift.

## Radio axis

- `SongFeatures.originCountries` — the credited-artist country set, aggregated
  in `RADIO_SONG_SELECT` via a `GROUP_CONCAT` over `library_song_artists`
  **UNIONed with the primary `s.artist_id`** (the junction is only populated
  after a rescan; the union makes the axis independent of that).
- **Weight `origin: 8`** — equal to BPM (enough to break the culture-blind tie
  when genre is broad or missing), under genre's 18 (a right genre still
  leads). A starting point: calibrate with
  `bun run packages/api/src/scripts/dump-radio.ts --weights origin=N` on real
  seeds before trusting it (the #187 B3 procedure).
- **`MISSING_ORIGIN_FLOOR = 0.2`** mirrors the genre floor: seed knows its
  origin + candidate doesn't → the axis scores the floor (reported in
  `floored`) instead of being skipped, else unknown-origin candidates dodge
  the axis and get mathematically *rewarded*. Safe because the backfill script
  makes "unknown" a shrinking transient.
- `toOrderable` carries `originCountries` and `seedCentroid` takes the modal
  country — the documented silent-kill spot (#187 B4: a column omitted from
  `toOrderable` kills the axis for every filter-radio candidate); a route test
  pins it.

## Filter, recipes, UI

- **`LibraryFilter.countries`** (`country=` comma-joined param): an `EXISTS`
  over the same credited-artist union as the radio pool. The `unknown` bucket
  is a `NOT EXISTS` — the curation lens for "which artists still need an
  origin". Albums/artists inherit through the any-track `EXISTS` wrapper.
- **Filter UI**: the panel's Origin section lists only countries present in
  the library (`GET /api/library/origin-countries` facets, lazy-loaded with
  the genres on first open) — a 249-entry dropdown would be noise.
- **Recipes**: `PlaylistRecipe.countries` composes through `songFilterWheres`
  in `candidatesFor` (one query path with the library tabs). `rio-de-la-plata`
  (AR/UY) ships as the worked example; which origin shelves exist is an owner
  decision — add/adjust entries in `RECIPES` freely.
- **Artist page**: `ArtistOriginComponent` renders flag + localized name under
  the artist name; curator-gated inline searchable picker issues
  `PUT /api/library/artists/:id/origin`. `country: null` writes a **user
  tombstone** (permanent "no origin", e.g. MB was wrong) — distinct from
  deleting the row, which would reopen the artist to the task. The display
  surface doubles as the data-quality feedback loop: a wrong flag gets
  noticed and fixed.

## Calibration

Run `dump-radio.ts` against the real library with `--weights origin=4/8/12` on
2-3 seeds including a regional (cuarteto/cumbia) seed, read the per-axis
breakdowns, and settle the weight + any region-table regrouping from evidence.
Record the chosen values and the reasoning here when done.
