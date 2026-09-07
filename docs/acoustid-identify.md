# Fingerprint identify and metadata candidates

The curator-facing "what is this recording, really?" tooling: a multi-source candidate
gatherer for album identity, and AcoustID fingerprinting for a single file. Both were
introduced with the download review inbox (#411, removed with instant landing — see
[library-processing.md](library-processing.md) "Landing is instant") and now serve the
library track-info sheet, the album metadata-fix modal and the MCP `identify_song` tool
([mcp-agent.md](mcp-agent.md)).

## Multi-source metadata candidates

`services/candidate-sources.ts` `gatherCandidates` merges metadata guesses
from up to four sources so a curator fixing a mis-tagged album isn't limited
to whichever one API happened to answer:

- `lidarr` — existing `FixLidarr` album search, omitted if Lidarr isn't
  configured.
- `musicbrainz` — new `searchReleaseGroups` call on `MusicBrainzClient`,
  omitted if unconfigured.
- `discogs` — a new `'release-candidates'` capability on the Discogs metadata
  plugin (see [docs/discogs-plugin.md](discogs-plugin.md)), omitted unless
  the plugin is enabled+configured.
- `tags` — reads the album's first song's own file tags directly (`readAudioTags`)
  — the offline, no-network fallback; always available if a music dir is set.

Each source runs with an independent 4s timeout (`withTimeout`) and degrades
to `ok:false` in the response rather than blocking the others or the whole
request; an unconfigured source is omitted from `sources[]` entirely (not
reported as failed). Results are deduped on an accent-folded
`(artist, title, year)` key and capped at 12 (`MAX_CANDIDATES`). The route
(`GET /albums/:id/metadata-candidates`) does not 503 when Lidarr is absent,
and the response carries `sources: Array<{ id, ok }>` (rendered as source chips in the
fix modal) and `identifyAvailable: boolean` (computed by checking whether an
enabled `identify` plugin exists — this check never actually spawns `fpcalc`,
so it's cheap enough to run on every request).

**Adding a fifth source** is one new branch inside `gatherCandidates` (or, for
a metadata-plugin-backed one, a new plugin capability like `discogs`'s
`release-candidates`) plus a `CandidateSourceId` union member — no route or
web change required, mirroring the north-star pattern used elsewhere in the
codebase (see "Source-agnostic acquisition" in the top-level index).

## AcoustID plugin (fingerprint identify)

`AcoustidPlugin` (`services/plugins/acoustid/`) is a new `metadata`-kind,
default-off plugin exposing the `identify` capability
(`identifyTrack(path): Promise<IdentifyResult | null>` plus the optional
`identifyTrackDetailed` — see "Identify outcome taxonomy" below). Config is
`{ apiKey, binaryPath }`; availability is probed by spawning the local
`fpcalc` binary with `-version` (never a real fingerprint call, so the probe
is cheap and offline-safe). **Promotion note**: `createApp`'s legacy
`acoustidApiKey` secrets option (previously dead weight with no consumer) now
seeds the plugin's `apiKey` at registration time
(`registerBuiltinPlugins` → `new AcoustidPlugin({ apiKey: acoustidApiKey ?? '' })`)
— an existing deployment that had already set this secret gets AcoustID
identify for free without re-entering a key.

### The capability also serves the library track-info sheet

The identify helpers (`identifyPlugin`/`identifyOne`/`computeIdentifyAvailable`)
live in `services/identify.ts`, shared by the MCP `identify_song` tool and the
track-info identify in `routes/library.ts`:

- `GET /api/library/identify/available` — the sheet's cheap availability flag
  (`computeIdentifyAvailable` — never spawns `fpcalc`).
- `POST /api/library/songs/:id/identify` (curator) — fingerprint one library song.
  503 if no plugin/music dir is configured.
- `POST /api/library/songs/:id/identify/apply` (curator) — per-song apply. The
  body **echoes the curator-approved suggestion** (the same trust the free-text
  tag edit gets) rather than re-running identify
  server-side, which would burn a second fpcalc+HTTP round-trip and could
  return a different match than the one approved. `buildIdentifyApplyTags`
  maps it onto `AudioTags` (`acoustId → acoustIdId`, `recordingId →
  mbRecordingId`, `releaseId → mbReleaseId` — the organizer's persist set);
  empty/placeholder strings and out-of-range numbers are **ignored, never
  written**, so a thin match can't wipe an existing tag; nothing applicable →
  400. On success it writes tags, runs the incremental rescan
  (`LibraryRoutesOptions.scanIncremental`),
  and `recordAudit`s `song.identify_apply`.

Web-side, the track-info sheet (`TrackInfoSheetComponent`) renders the
Identify button + suggestion card (curator-gated, hidden when unavailable);
the failure-kind → i18n-key mapping is the pure
`lib/identify-failure.ts` `identifyFailureKey`.

### The image must carry `fpcalc` (issue #548)

`fpcalc` is spawned by bare name (`acoustid-lookup.ts`'s `binaryPath` default),
and the Dockerfile's apt line did not install `libchromaprint-tools` — so every
identify in a container answered `fpcalc-missing`, whose own remediation text
("install `libchromaprint-tools`") is un-actionable inside an image you only
pull. It went unnoticed because the plugin is `defaultEnabled: false` *and*
needs an API key, so only a deliberately-configured deployment ever reached the
failure.

The image now installs the package. The general hazard — a binary spawned by
bare name with nothing tying it to the image that must provide it — is guarded
by `scripts/dockerfile-runtime-binaries.test.ts`, which pairs each binary with
its Debian package **and** re-derives the premise from the source that spawns
it, so renaming the default fails the test rather than silently voiding the
mapping. Add an entry there when introducing a new spawned binary.

## Identify outcome taxonomy (issue #414)

`identifyTrack` answers `IdentifyResult | null`, which collapsed four
situations that ask a curator for **opposite actions** into one "No fingerprint
match" toast:

| outcome | what happened | what the curator should do |
| --- | --- | --- |
| `match` | AcoustID matched | accept the suggested tags |
| `no-match` | AcoustID answered, has no such recording | retag by hand |
| `fpcalc-missing` | the binary isn't installed | install `libchromaprint-tools` — no file is at fault. The Docker image ships it (see "The image must carry `fpcalc`" below), so in a container this points at a wrong `binaryPath`, not a missing package |
| `undecodable` | `fpcalc` ran and rejected *this file* | likely a truncated/corrupt download — a discard candidate |
| `source-error` | HTTP/network failure, unconfigured key | retry later; says nothing about the file |
| `file-missing` | the row's path is not on disk | a scan/organizer problem, not a metadata one |

The capability gained an **optional** `identifyTrackDetailed(absPath):
Promise<IdentifyOutcome>` rather than changing `identifyTrack`'s signature, so a
plugin that only implements the plain call stays valid — the route falls back to
mapping its null onto `no-match`. The identify route returns
`{ result, outcome }`: `result` is byte-identical to before (no client break),
`outcome` is the addition.

`undecodable` **carries fpcalc's stderr tail** (last 400 chars, in the outcome's
`detail`). Two things were wrong before: `runFpcalc` piped stderr and never read
it, so the diagnosis was discarded at the source; and an exit-0-with-no-usable-
fingerprint (silence, zero-length audio) was indistinguishable from a real
no-match even though it is a property of the *file*. This follows the same
discipline the enrichment pipeline already applies to ffmpeg failures — surface
the stderr tail, never swallow it as a bare exit code.

**An unfingerprint-able file is itself a triage signal**, which is why the web
renders it per-track rather than as one modal-level message: the metadata-fix
modal shows an error chip under the offending row
(`data-reason` = the kind, stderr tail in the `title` tooltip), styled `text-status-error` for the actionable
kinds and muted for a plain `no-match`; the toast likewise switches from `info`
to `error`. In a bulk album identify, one unreadable file among ten is exactly
the thing a per-row chip surfaces and a single verdict would average away.

## Retag-vs-override persistence rationale

There are two "fix the metadata" paths, and they intentionally persist differently:

- **Per-song facts** (title, artist, track number — `PATCH /api/library/songs/:id/metadata`,
  the MCP `fix_song_metadata`, the identify apply above) **retag the file on disk, then
  rescan** — never `library_metadata_overrides`, which is album-scoped and has no title
  column. `songId` is path-derived, so playlists, likes and history keep pointing at the
  song, and the corrected tag survives a from-scratch rescan rather than depending on an
  override row surviving alongside a wrong tag.
- **Album identity fixes** (the [user-driven metadata fix](metadata-optimize.md),
  `applyMetadataFix`) go through `library_metadata_overrides`, because the *name-derived*
  album id has live references (playlists, plays, starred songs) and a file retag would
  re-mint it mid-flight and orphan them.

Both paths reuse the *fix* mechanics (candidate search, the fix modal) — only the *write*
target differs, and the difference is whether the identifier being corrected is one other
tables depend on.
