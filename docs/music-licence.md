# Music licence / rights per track

A track can carry a **rights/licence** value (Public Domain, a Creative Commons
flavour, All Rights Reserved, …) so users can tell what they're allowed to do
with it, filter by it, and — as a follow-up — find whole albums/compilations
that are Public Domain. Before this feature there was **no** notion of
licence/copyright anywhere in the metadata path.

The design deliberately mirrors the **genre** property end-to-end (a per-song
scalar that is displayed, curator-editable, filterable, tag-mirrored, and
COALESCE-preserved across rescans), because that path is already proven.

## Vocabulary (the one closed set)

`packages/core/src/types/licence.ts` — a browser-safe, pure module shared by the
API (scanner, tag seam, filter SQL, enrichment) and the web UI:

- `LICENCE_VOCAB` — the canonical codes: `public-domain`, `cc0`, `cc-by`,
  `cc-by-sa`, `cc-by-nc`, `cc-by-nd`, `cc-by-nc-sa`, `cc-by-nc-nd`,
  `all-rights-reserved`, `unknown`.
- `LICENCE_LABELS` / `LICENCE_BADGES` — human label + compact chip ("PD", "CC BY").
- `isLicenceCode` / `isFreeLicence` — guards.
- `normalizeLicence(raw)` — maps a free-text / URL rights string (a file tag's
  `LICENSE`/`COPYRIGHT`/`WCOP` frame, or a MusicBrainz `license` url-relation) to
  a canonical code. **Positive identifications only:** it returns `null` for
  unrecognised input *and* never guesses `all-rights-reserved` from a bare
  copyright notice ("© 2020 Artist" → `null`, not ARR). Only literal
  "all rights reserved" maps to ARR.

### `unknown` is a UI/filter bucket, never a stored value

A track with no known licence is stored as SQL **NULL**, not the string
`"unknown"`. That keeps the background enrichment task (which fills
`WHERE licence IS NULL`) trying to resolve it, and lets the filter's `unknown`
bucket mean "un-licenced" (`licence IS NULL`). Setting a track's licence to
`unknown` from the UI clears it (stores NULL).

## Storage & the rescan-durability contract

`library_songs` gains two additive columns (`db.ts`, same idempotent
`ALTER TABLE … ADD COLUMN` pattern as `bpm`/`energy`):

- `licence TEXT` — the canonical code.
- `licence_source TEXT` ∈ `{tag, musicbrainz, user}` — provenance.

The scanner (`library-scanner.ts`) threads `licence` through
`ScannedTrack → SongRow → persist`, with
`licence = COALESCE(excluded.licence, library_songs.licence)` in the upsert —
identical durability to `bpm`/`genre`: a rescan that reads a `LICENSE` tag
refreshes it; a tag-less rescan keeps a value the task or a curator wrote. The
scanner **never writes `licence_source`**, so a manual `user` source survives
rescans (mirrors how `landed_at` is left untouched).

## Where it comes from ("efficiently retrieve, reasonable accuracy")

Licence metadata is genuinely sparse, so retrieval is layered, most-reliable
first, and honest about misses:

1. **File tags (zero network, high precision).** `audio-tags.ts`
   `licenceFromTags(native, copyright)` reads `LICENSE` → `WCOP` → `TCOP` →
   `COPYRIGHT` (and the music-metadata `common.copyright` fold), normalised via
   `normalizeLicence`. The scanner applies this on the first scan, so archive.org
   / Creative-Commons downloads are licence-tagged with no network calls. Writes
   go to a `LICENSE` frame **only** (never the native copyright frame, so an
   existing "©" notice is preserved).
2. **MusicBrainz `license` url-relations.** `musicbrainz-client.ts`
   `getLicence({ mbRecordingId?, mbReleaseId?, artist?, title? })` fetches with
   `inc=url-rels` (recording first, then release) and maps a `license` relation's
   URL through `normalizeLicence`. Reuses the existing base-url / 1-req-sec /
   file-cache plumbing — no new HTTP client. Coverage is sparse (mostly CC
   releases); a miss returns `null`, never a false positive.
3. **Manual set.** A curator picks a value in the track-info sheet.

## The `licence` enrichment task (background fill)

`packages/api/src/services/enrichment/tasks.ts` — one `EnrichmentTask` appended
to `ENRICHMENT_TASKS`, mirroring `genreTask`:

- `countPending` / `run` select `WHERE licence IS NULL` (excluding ledgered
  files via `notPermanentlyFailedClause`).
- Resolves via the injected `ctx.lookupLicence` primitive (tag-first, then MB;
  built from `dataDir` for the MB cache).
- On a hit: `UPDATE … SET licence, licence_source` + mirror to the file's
  `LICENSE` tag + `clearAnalysisFailure`.
- On a confident miss: ledgered via `NoConfidentResultError` — it drops out of
  the pending set (no eternal re-query) but is **not** tallied as a run failure
  (nothing is broken; MB simply has no data), exactly like unresolvable genre.

### Not a landing gate

`licence` is in `DEFAULT_PROCESSING_SETTINGS.tasks` (default on) but **not** in
`.gates`. An optional, uncertain, network-dependent source must never hold a
fresh download in quarantine, so a licence is filled in the background and a
download lands without waiting on it.

### Bulk backfill

`packages/api/src/scripts/backfill-licence.ts` — dry-run by default, `--apply`
writes DB + tag, `--no-mb` for a fast tags-only pass. Same shape as
`backfill-genre.ts`.

## Filtering

`LibraryFilter` gains `licences?: string[]` (`library-filter.ts`, with
serialize/parse/param-keys/count). The shared `licenceWheres(codes, col)`
(`library-filter-sql.ts`) emits `col IN (…)` for positive codes and
`col IS NULL` for the `unknown` bucket (ORed together), used two ways:

- **Songs** (`songFilterWheres`, `s.licence`): filter tracks by their own licence.
- **Albums / Compilations** (`albumFilterWheres`): filter the **stored album
  aggregate** `library_albums.licence` directly — "the album is *entirely* this
  licence" — so the `unknown` bucket = a mixed/un-licenced album. Licence is
  removed from the any-track EXISTS here so it isn't double-applied.
- **Artists** (`artistFilterWheres`): no album-style aggregate exists, so licence
  stays an any-track match ("artist has a track with this licence").

## Web UI

- **Track-info sheet** (`track-info-sheet.component`): a Licence row showing the
  current value as a chip, a **Detect** button (calls the read-only suggestion
  route), and — for curators — a vocabulary `<select>` to set it + an Apply
  button when a detected value differs. Modeled on the genre chips + apply flow.
- **Filter panel** (`library-filter-panel.component`): a Licence chip group
  (`toggleLicence`), mirroring the mood chips.
- **Admin → Library processing**: a "Licence / rights (tags → MusicBrainz)"
  task toggle.

## API

- `GET  /api/library/songs/:id/licence-suggestion` — read-only detect (tag → MB);
  `{ current, suggested, source }`.
- `POST /api/library/songs/:id/licence` — set/clear (curator-gated, audit-logged);
  `{ ok, licence }`. `''`/`unknown` clears (NULL); a valid code is stored with
  `licence_source='user'` and mirrored to the file tag.

Both live in `routes/library.ts` next to the genre routes.

## Why not …

- **Default unknowns to All Rights Reserved?** No — that asserts a legal status
  we can't verify. Unknown stays unknown (NULL).
- **A side table instead of a column?** The column + tag-mirror + COALESCE +
  `licence_source` guard already makes user values survive rescans (the task only
  touches `licence IS NULL` rows, and the scanner never overwrites the `user`
  source), so no side table is needed — same as `genre`/`bpm`.
- **A gate?** No — see "Not a landing gate".

## Tests

- `licence.test.ts` — the `normalizeLicence` mapping table (URLs, CC clause text,
  PD/CC0, never-guess-ARR, round-trip of canonical codes).
- `library-filter.test.ts` — `licences` serialize/parse round-trip + lenient drop.
- `library-filter-sql.test.ts` — the `IN` / `IS NULL` (unknown) branches.
- `musicbrainz-client.test.ts` — `getLicence` url-rels parsing + caching.
- `enrichment/tasks.test.ts` — the `licence` task (fill + ledgered miss).
- `audio-tags.test.ts` — ID3 `LICENSE` round-trip + read-side URL normalization +
  `licenceFromTags` priority.
- `library.analyze.test.ts` — the set/clear/validation/role-gating + suggestion
  routes.

## Album / compilation "Public Domain" (the aggregate)

`library_albums.licence` (ALTER-only column, indexed) holds the **unanimous**
licence code across an album's tracks — `unanimousLicence(codes)` in
`library-scanner.ts`: the single code every track shares, else `null`. A single
un-licenced track makes the album non-unanimous, so an album reads as "Public
Domain" only when **every** track is PD — exactly the semantics the PD-albums
filter needs.

- **Aggregation** happens in the `buildLibrary` reduce from the tracks' scanned
  (tag-state) licences — like the album genre/year — so an enrichment fill is
  reflected on the **next full rescan**. Persisted with `licence = excluded.licence`
  (overwrite, since it's a full recompute each scan).
- **Surfaced** through `ALBUM_SELECT` → `rowToAlbum` → the `Album` / `AlbumDetail`
  DTOs (absent when `null`).
- **Filtered** on the album row directly (see Filtering above), so the Albums and
  Compilations tabs can show "Public Domain only".
- **Badged** on the album page header (`album-detail` `licenceLabel` + a chip),
  `data-testid="album-licence-badge"`.

Because it's tag-state-derived at scan time, an album's aggregate can lag behind
per-track enrichment until the next full rescan — an accepted trade-off matching
the album genre's behaviour.
