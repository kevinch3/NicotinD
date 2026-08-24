# Popularity / hotness signal (issue #220)

Every other per-song signal in the library is **intrinsic** — BPM, key, energy,
genre all come from the audio or its tags. Popularity is the first
**extrinsic** one: how widely listened a recording is, so the library can answer
"which of this artist's tracks are the hits?" for radio seeding, "Popular"
curated shelves, and acquisition prioritization.

## Source: ListenBrainz

`ListenBrainzClient` (`packages/api/src/services/listenbrainz-client.ts`) calls
one endpoint, `POST /1/popularity/recording`, which returns a global
`total_listen_count` per **recording MBID**. ListenBrainz was chosen as the
first (and, for now, only) source because it is:

- **MBID-native** — keyed on the MusicBrainz recording id, which is exactly what
  the rest of the library already speaks, and
- **credential-free** — no API key, no OAuth, unlike Spotify's `Track.popularity`
  (the industry 0–100 signal), which would need the spotify plugin's creds and an
  MBID→spotify-id resolution hop. Spotify remains a plausible *second* source
  behind the same column; nothing here forecloses it.

The client is rate-limited to 1 req/s, batches up to 100 MBIDs per call, and
caches each result on disk (`<dataDir>/listenbrainz-cache.json`) — a recording's
aggregate listen count barely moves day to day, so re-fetching every window would
be waste.

### The recording MBID comes from the file tag

The task keys ListenBrainz on `mbRecordingId`, read from the file's own tags —
the same tags-first discipline the scanner follows everywhere, and the reason a
song with **no** recording-MBID tag is a *confident miss* rather than a fuzzy
artist+title name search (which `docs/library-scanner.md` deliberately avoids for
identity). ListenBrainz *does* offer a fuzzy MBID mapper; wiring it in as a
fallback to lift coverage where tags are sparse is a documented future step, kept
out of v1 to stay consistent with the codebase's no-fuzzy-lookup rule.

## Storage

Additive columns on `library_songs` (`db.ts`), the same additive-column contract:

- `popularity REAL` — a **normalized 0–1 scalar** (see below). NULL = unknown, so
  the enrichment task (`WHERE popularity IS NULL`) keeps trying.
- `popularity_source TEXT` — provenance, `'listenbrainz'` today.

Unlike genre/bpm, popularity is **not mirrored to a file tag**: it is
extrinsic and drifts over time, so it lives only in the DB column. That also
means the scanner never writes it — the column is simply absent from the
scanner's upsert, so it survives a rescan untouched (no COALESCE needed).

### Normalization

`normalizePopularity(listenCount)` maps a raw count to 0–1 on a **log scale**:
`min(1, log10(count+1) / log10(POPULARITY_REFERENCE))`, with
`POPULARITY_REFERENCE = 1_000_000` (a recording with ~1M listens reads as ~1.0).
The listen distribution is heavily long-tailed, so a linear map would collapse
the obscure majority to ~0 and let a handful of mega-hits own the whole range;
the log keeps the scalar spread across a real library. A zero/negative count →
0 (an obscure but real recording). `POPULARITY_REFERENCE` is a **documented,
tunable constant, not a measured universal** — if a deployed library clusters too
high or low, it is the one knob to turn.

## The `popularity` enrichment task

`packages/api/src/services/enrichment/tasks.ts` — one `EnrichmentTask`, mirroring
the other optional fills:

- **Default-on** in `DEFAULT_PROCESSING_SETTINGS.tasks`, **never a gate**: an
  extrinsic network signal must never hold a fresh download in quarantine.
- `countPending` / `run` select `WHERE popularity IS NULL` (excluding ledgered
  songs via `notPermanentlyFailedClause`).
- **Batched**: it reads each pending song's `mbRecordingId` tag, groups songs
  sharing one, and sends all the MBIDs in a single `getListenCounts` call — a
  large backlog costs a handful of requests, not one per song.
- **Three miss modes**, deliberately distinct:
  - *No recording MBID* → confident miss, ledgered-not-tallied via
    `NoConfidentResultError` (the file must be re-tagged/re-downloaded to change
    this, which resets the ledger).
  - *ListenBrainz confirmed no data* (a `null` count in the response) → same
    ledgered-not-tallied miss.
  - *Transient failure* (429 / outage → the MBID is absent from the response
    map) → **not** ledgered, so it retries next window. A misconfig or a
    ListenBrainz hiccup can never permanently exclude a song — the same posture
    as the sidecar 404/503 un-ledgered rule.
- On a hit: `UPDATE … SET popularity, popularity_source` + `clearAnalysisFailure`.

Admin panel: a "Popularity (ListenBrainz)" task toggle in Library processing.

## Bulk backfill

`packages/api/src/scripts/backfill-popularity.ts` — dry-run by default, `--apply`
writes the DB (no file-tag write, since popularity isn't tagged). Same shape as
the other backfill scripts; resolves MBIDs from tags, batches the ListenBrainz lookup,
reports scored / no-data / no-MBID-tag counts.

## Deliberately left as follow-ups

The issue lists several consumers; v1 ships the **signal itself** and leaves the
product-decision consumers for later, each behind its own choice:

- **Radio scoring** — whether popularity becomes a weighted axis in
  `scoreSimilarity` / `toOrderable`, or is used only in curated-playlist recipe
  `where`/`sort`.
- **Album/artist aggregate** — max-track vs. mean (a unanimity rule, or a
  numeric aggregate).
- **A local play-count axis** — an internal, no-network complementary signal, and
  whether it feeds the same column or a separate `internal_popularity`.
- **A ListenBrainz MBID-mapper fallback** to lift coverage where tags carry no
  recording MBID.
