# Download inbox triage (hold-for-review, issue #411)

## Problem

The [process-before-landing quarantine gate](download-pipeline.md#process-before-landing-quarantine-gate)
lands a download automatically once its required enrichment steps finish (or the
24h safety valve fires) — good for hands-off operation, but it means a
mis-tagged or wrong-album download can land silently, with no human ever
having looked at it. Feedback from real use
([docs/feedback-log-2026-07.md](feedback-log-2026-07.md)) was that downloads
need triage — review, fix metadata, or delete — *before* they join the
library, not after. This feature adds an opt-in curator inbox that sits in
front of landing.

## The `holdForReview` gate

`ProcessingSettings.holdForReview` (default `false`) is a new admin toggle
(Admin → Library processing, `data-testid="processing-hold-for-review"`,
`PUT /api/admin/processing`). When on, `graduatePending` requires an
**additional**, human-authored condition on top of the existing step/valve
gate — on **both** branches (the no-required-steps fast path and the normal
steps-or-valve path):

```
gate = (stepsOrValve) AND reviewCond
```

`reviewCond` is `EXISTS` an **approved** `download_reviews` row for the song's
album, `reviewed_at >= created`. Two deliberate independences:

- **Outside the 24h safety valve.** The valve exists to rescue songs stuck on
  an un-ledgered enrichment failure (sidecar down, decode outage) — it must
  never rescue a song nobody has looked at yet. Review is ANDed onto the valve
  branch too, so a held album that's been pending for days still doesn't land
  itself.
- **Independent of `NICOTIND_DISABLE_LANDING_GATE`.** That env var only empties
  the *enrichment task* list (used by e2e to avoid waiting on sidecars/ffmpeg);
  it has no opinion on human review. The e2e suite runs with the landing gate
  disabled and still exercises `holdForReview` — see "e2e notes" below.

Off (the default), `reviewCond` is `null` and the gate reduces exactly to the
pre-#411 behavior — zero change until an admin opts in.

### Acquisition-off corner (issue #416)

With the deployment-wide acquisition kill-switch off (issue #235) the Downloads
page — and the review inbox rendered on it — is hidden from every user, but a
**manual file drop into the music dir still scans**. Held files would then wait
behind an approval no UI can grant, indefinitely (review is deliberately
outside the 24h valve). Two coordinated guards close this:

- **Belt — the landing gate ignores the flag while acquisition is off**:
  `LibraryProcessingService` takes an `acquisitionEnabled` dep (the live
  `AcquisitionToggle` state, re-checked every pass since the toggle is
  runtime-flippable) and computes `reviewHoldActive(db, holdForReview &&
  acquisitionEnabled())`. This covers the setting-predates-the-switch-off
  history: however the flags got into that combination, nothing strands.
- **Braces — `PUT /api/admin/processing` denies *enabling*** `holdForReview`
  while acquisition is off (400 with the explanation), and the Admin toggle is
  disabled with an inline note (`data-testid="hold-needs-acquisition"`), so the
  admin learns *why* instead of watching a toggle silently do nothing.

### Deferred minors from the #411 ledger (closed by #416)

- `searchReleaseGroups` now Lucene-escapes `"`/`\` inside its phrase terms
  (same helper shape as `archive-search.service.ts`) — a quote in an album
  title used to break out of the phrase and corrupt the whole query.
- The path-safety triad (`expandDir` → `resolveSongPath` → `isUnderMusicDir`)
  is extracted to `services/song-path.ts` — one implementation instead of the
  three byte-identical copies in routes/library.ts, services/library-deletion.ts
  and routes/download-review.ts (the resolve-only variants in
  `track-backfill.ts`/`candidate-sources.ts` intentionally stay local — they
  omit the containment check for paths legitimately outside the library).
- `hidden = 1` rows are covered by tests: they never surface in the review
  queue nor inflate the pending badge.

### Bootstrap exemption (fresh database)

Turning `holdForReview` on for a **brand-new** database is a flood, not a
triage aid: the very first library scan lands dozens or hundreds of songs in
one bootstrap drain, and without an exemption every one of them would pile
into the inbox as if a curator needed to individually approve their own
freshly-imported collection. Issue #417 closes that with a one-way marker,
`review_hold_armed_v1`, in `library_sync_state` (`services/download-review-store.ts`
`reviewHoldArmed`/`armReviewHold`/`maybeArmReviewHold`). `reviewCond` is only
consulted once the marker is armed (`reviewHoldActive(db, holdForReview) =
holdForReview && reviewHoldArmed(db)`) — an unarmed database behaves exactly
like `holdForReview` off, regardless of the toggle.

The marker is armed at two independent sites:

- **`applySchema`, end of migration** — armed for any library that already
  has at least one landed song, so an *upgrade* of an established install is
  armed immediately, including one that already has a pending review inbox
  at deploy time (nothing that was already sitting for review gets swept
  under the rug by the migration). This is a weaker condition than the
  runtime site below — it doesn't require quarantine to be empty — because on
  an upgrade the pre-#411 library is, by definition, not something the
  marker needs to protect from flooding.
- **`graduatePending`'s tail (runtime)** — `maybeArmReviewHold` fires on
  every run, toggle-independent (arms even with `holdForReview` off so the
  marker is ready the moment an admin turns the toggle on), but only once at
  least one song has landed **and** quarantine is fully empty. That stronger
  condition keeps a multi-batch bootstrap drain (a fresh scan importing
  thousands of songs across many `graduatePending` batches) exempt
  end-to-end — arming after the *first* batch lands would flood the inbox
  with every subsequent batch's worth of songs.

Both are one-way (never unset) and independent of the `holdForReview` toggle
itself, so flipping the toggle off and back on doesn't re-flood an
already-established library, and a wiped-then-rescanned database naturally
re-enters bootstrap (the marker lives in the same file that got wiped).

**Why not reuse `landing_backfill_v1`?** That marker is consumed earlier in
the same migration, while `library_songs` is still empty on a genuinely
fresh database — checking "any landed song" against an empty table at that
point would never arm, so a fresh install would stay permanently unarmed
even after its first scan completed. The two markers answer different
questions (`landing_backfill_v1`: "has the one-time land-everything migration
run?" vs `review_hold_armed_v1`: "has this library ever finished landing
something?") and have to be checked at different times to mean what they say.

Two transients are accepted rather than engineered away:

1. A **brand-new install** whose first-ever content arrives as a download
   (not a bootstrap scan) with the toggle already on lands unreviewed — there
   is no prior "established library" for the upgrade site to have armed, and
   the runtime site only arms after quarantine drains, i.e. after this same
   song has already landed.
2. A download that **arrives mid-bootstrap-drain** (while earlier batches are
   still quarantined) lands unreviewed alongside the rest of that drain,
   bounded by the same step/valve gate as the drain itself — once unarmed,
   the plain `stepsOrValve` condition (including the 24h valve) applies with
   no review requirement layered on top.

Both are self-limiting (they can only happen before the marker arms, and
arming happens automatically the moment the library has anything landed) and
are judged an acceptable trade against re-flooding the inbox on every fresh
install.

## `download_reviews` — an album-keyed decision table, not a status column

```sql
CREATE TABLE download_reviews (
  album_id    TEXT PRIMARY KEY,
  state       TEXT NOT NULL,          -- 'approved' | 'discarded'
  reviewed_by TEXT,
  reviewed_at TEXT NOT NULL
);
```

There is deliberately no `pending` state stored anywhere — **pending is
derived**, not written. A song is pending review when it's quarantined
(`landed_at IS NULL`, `hidden = 0`) and there is **no covering decision row**:

```sql
NOT EXISTS (
  SELECT 1 FROM download_reviews r
   WHERE r.album_id = library_songs.album_id
     AND (library_songs.created IS NULL OR r.reviewed_at >= library_songs.created)
)
```

("Covering" here means "recorded at or after this song was scanned in" — see
below.) This keeps the state machine to two writes (`approve`/`discard`)
instead of three, and makes "nothing decided yet" the natural absence of a
row rather than an explicit value that has to be inserted and later
invalidated.

### The `reviewed_at >= created` rule (wave-2 / re-download semantics)

An approval is scoped to the songs that existed *at the time it was given* —
not to the album forever. If a curator approves album X, and a second
download wave later adds more (or replacement) tracks to the same album, or
the whole album is deleted and re-downloaded, those new `library_songs` rows
carry a fresh `created` timestamp *after* the old approval's `reviewed_at`.
The `>=` comparison means the old approval no longer covers them, so the
album goes back to pending — a curator reviews the *new* content rather than
having a stale one-time yes silently wave through material they never saw.
Discard rows behave the same way and are equally "covering": once discarded,
a still-un-landed remnant of that album stays hidden until a fresh decision
is made (a discard already runs `deleteAlbum` — see below — so in practice
there's rarely anything left to re-pend against, but the SQL doesn't special
case it).

## Routes (`/api/review`, curator-gated)

| Route | Purpose |
| --- | --- |
| `GET /queue` | Pending albums (quarantine metadata + `year`). Returns `{ albums: [] }` when `holdForReview` is off, and stays empty until the library has first-established landed content (same `reviewHoldActive` helper as the landing gate — see "Bootstrap exemption" above) — with the toggle off, or before the bootstrap marker arms, ordinary enrichment quarantine must never surface as an inbox (zero-behavior-change guarantee). |
| `GET /count` | `{ pending: number }` — backs the nav badge + inbox poller. Returns `{ pending: 0 }` when `holdForReview` is off or the bootstrap marker hasn't armed yet (same gating as `/queue`). |
| `POST /albums/:id/approve` | Records an `approved` decision, audits `download_review.approve`, then **awaits `landAlbumNow`** (issue #708) so the album shows up in the library essentially immediately instead of waiting on the next window tick. Idempotent (upsert on `album_id`). Response is `{ ok: true, landed: true }` (200) once landed, or `{ ok: true, landed: false, timedOut, pendingTasks, pendingSongCount }` (202) if it's still processing — the approve decision itself always succeeds either way; `landed` only reports visibility. |
| `POST /albums/:id/discard` | Runs the **shared** `deleteAlbum` (same function library delete + the MCP delete tool use — `services/library-deletion.ts`), then records a `discarded` decision, audits `download_review.discard`. |
| `POST /songs/:id/identify` | Fingerprint one track via the enabled `identify` plugin (AcoustID). 503 if no plugin/music dir configured. |
| `POST /albums/:id/identify` | Fingerprints up to 5 quarantined tracks for the album sequentially (rate-limit-friendly), returns each track's result plus a majority-vote album guess (`voteAlbumIdentity`: needs ≥2 votes **and** more than half of successful results to agree — a lone match or a tie suggests nothing). |
| `POST /albums/:id/tracks` | Per-track retag (title/artist), writes tags to the file, then an incremental rescan. A track with no fields to update fails with `'No fields to update'`; other tracks in the same request still get written (partial success surfaces per-track). Audits `download_review.retag`. |

All routes require `requireCurator` — role gating detail below.

## Instant landing on approve (`landAlbumNow`, issue #708)

Before #708, `approve` fired `void deps.kickEager?.()` — un-awaited, so the
route returned before landing even started. Worse, `kickEager()` itself
silently no-ops (`if (this.busy) return`) whenever a periodic `tick()` or
admin `runNow()` is already mid-flight, and its drain loop, when it does run,
processes the *library-wide* pending-gate-task queue (oldest-first,
unscoped), not just the approved album — so a bare `await kickEager()` would
have blocked the request on unrelated backlog, or worse, resolved instantly
having landed nothing at all. See
[library-processing.md](library-processing.md#landalbumnow-instant-landing-on-approve)
for the fix: `landAlbumNow(albumId)` waits (bounded) for the shared lock
instead of no-op'ing, drains only *this* album's pending gate-task rows, and
returns a typed `{ landed, timedOut, pendingSongCount, pendingTasks }` instead
of `void`. `approve` awaits it and reflects the result in its response (200
`landed:true` vs 202 `landed:false`) — the `download_reviews` decision itself
is always recorded regardless of how landing goes.

On the web side, `TransferService.noteAlbumsLanded`/`newlyLandedAlbumIds` is a
narrow signal — set only from a confirmed `landed:true` response, never
speculatively — that `LibraryComponent` uses to show a "New album added"
banner. It deliberately does not auto-reload the grid: an earlier `libraryDirty`
effect that did so (auto-`resetAndLoad()` on any unrelated transfer
completion) was removed for exactly that reason (commit `2493a714`), so the
banner only reloads on the viewer's own click.

`GET /api/admin/review`'s `downloadReviews` slice (`pendingReviewStats`) feeds
a hidden-at-zero Admin panel row (`data-testid="review-held-panel"`, "N
albums held for review — oldest waiting D days") directly under the toggle.
It shares the exact same pending predicate (`PENDING_REVIEW_SQL`) and the
same `reviewHoldActive` gate as `/queue` and `/count`, so the admin number
always equals what the inbox shows — there is no separate counting path that
could drift from what a curator actually sees.

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
(`GET /albums/:id/metadata-candidates`) **no longer 503s when Lidarr is
absent** — the pre-#411 behavior since Lidarr was the only source — and the
response adds `sources: Array<{ id, ok }>` (rendered as source chips in the
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
live in `services/identify.ts`, shared by this inbox and the general-purpose
track-info identify in `routes/library.ts`:

- `GET /api/library/identify/available` — the sheet's cheap availability flag
  (same no-`isAvailable()` reasoning as `computeIdentifyAvailable`).
- `POST /api/library/songs/:id/identify` (curator) — identical contract to the
  review route, but for any library song.
- `POST /api/library/songs/:id/identify/apply` (curator) — per-song apply. The
  body **echoes the curator-approved suggestion** (matching how the review
  retag trusts free-text title/artist) rather than re-running identify
  server-side, which would burn a second fpcalc+HTTP round-trip and could
  return a different match than the one approved. `buildIdentifyApplyTags`
  maps it onto `AudioTags` (`acoustId → acoustIdId`, `recordingId →
  mbRecordingId`, `releaseId → mbReleaseId` — the organizer's persist set);
  empty/placeholder strings and out-of-range numbers are **ignored, never
  written**, so a thin match can't wipe an existing tag; nothing applicable →
  400. On success it writes tags, runs the incremental rescan
  (`LibraryRoutesOptions.scanIncremental`, mirroring `DownloadReviewDeps`),
  and `recordAudit`s `song.identify_apply`.

Web-side, the track-info sheet (`TrackInfoSheetComponent`) renders the
Identify button + suggestion card (curator-gated, hidden when unavailable);
the failure-kind → i18n-key mapping is the shared
`lib/identify-failure.ts` `identifyFailureKey`, reusing the `review.identify*`
strings so the two surfaces can't drift.

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
mapping its null onto `no-match`. Both identify routes now return
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
(`data-testid="review-track-identify-error"`, `data-reason` = the kind, stderr
tail in the `title` tooltip), styled `text-status-error` for the actionable
kinds and muted for a plain `no-match`; the toast likewise switches from `info`
to `error`. In a bulk album identify, one unreadable file among ten is exactly
the thing a per-row chip surfaces and a single verdict would average away.

## Canonical tracklist (issue #413)

MusicBrainz is the only candidate source that publishes a **per-track**
tracklist, so it gets its own route rather than a field on the generic
candidate contract: `GET /api/library/musicbrainz/release-groups/:rgid/tracklist`
(curator-gated, 503 without an MB client). The fix modal shows **Apply
MusicBrainz titles** above the track grid exactly when a `musicbrainz`
candidate carrying a release-group id is on screen.

Three decisions worth keeping:

- **Two hops, and the release pick matters.** A release *group* has no tracks
  (it is the abstract "album"), so the tracklist comes off one of its releases.
  The pick is the **Official** release with the **most** tracks, not the first
  listed — MB lists promos, single edits and partial digital editions alongside
  the real album, and a short one would silently truncate the tracklist a
  curator is about to apply. Non-official releases are used only when there is
  no official one. Only the first medium is returned: a curator is matching one
  folder's worth of files, and flattening multi-disc positions would renumber
  them wrongly.
- **Matched by position, never by title.** A curator reaches for this precisely
  when the existing titles are junk (`01 - track01`), so title similarity is the
  one signal that cannot be trusted. A row's position is its track number, or
  its place in the (already track-ordered) grid when it has none — so a folder
  with no track tags still lines up in file order. A row with no canonical
  counterpart is left untouched, never blanked.
- **Titles only, and nothing is saved.** MB's per-track credits are
  recording-level, so applying them would smear the wrong artist across a
  compilation; artist stays the album-level decision the modal already makes.
  The rows go dirty and the curator still reviews them and presses **Save
  tracks**, exactly like a fingerprint match — the action fills the grid, it
  does not retag behind their back.

The overlay itself is the pure `applyCanonicalTracklist`
(`web/src/app/lib/review-tracks.ts`), unit-tested alongside its siblings.

## Retag-vs-override persistence rationale

There are two different "fix the metadata" paths in the codebase now, and
they intentionally persist differently:

- **Quarantine-time per-track fixes** (`POST /albums/:id/tracks`, this
  feature) **retag the file on disk, then rescan** — never
  `library_metadata_overrides`. At quarantine time nothing in the library yet
  references these songs (they're hidden), so there is no downstream
  consumer (playlists, radio, likes) whose reference would be orphaned by a
  retag-and-rescan round-trip. Writing straight to the file is also strictly
  more correct: the corrected tag survives forever, including a future
  from-scratch rescan, rather than depending on an override row surviving
  alongside a wrong tag.
- **Post-landing album identity fixes** (the existing
  [user-driven metadata fix](metadata-optimize.md), `applyMetadataFix`) go
  through `library_metadata_overrides` instead, because by then real
  references exist (the album may be in playlists, have plays, have starred
  songs, etc.) and a file retag would re-mint IDs mid-flight and orphan them.

Both paths reuse the *fix* mechanics (candidate search, the fix modal
component) — only the *write* target differs, and that difference is driven
by whether the song already has a live identity for other tables to depend
on.

## Role gating

Every `/api/review/*` route uses `requireCurator` (the `refiner`/`admin`
ladder rung — see [docs/roles.md](roles.md)), matching every other library
curation surface (identity fixes, genre overrides, deletion). A `user` or
`listener` never sees the inbox: `DownloadReviewService`'s poll (below) is
gated the same way on the web side, so a non-curator's Downloads page never
even issues the `GET /api/review/count` request.

## Web surface

- `ReviewApiService` (`services/api/`) + `DownloadReviewService` — a
  30-second, ref-counted, curator-gated poller (mirrors the `ServiceReview`
  pattern's "one shared interval, many consumers" shape) backing a nav badge
  (folded into the layout + bottom-nav unread-count treatment) and the inbox
  list itself.
- `ReviewInboxComponent`, rendered on the Downloads page
  (`data-testid="review-inbox"`), one row per pending album with **aggregated
  per-step badges** (bpm/key/energy/genre/… rolled up across the album's
  quarantined tracks, skipped steps rendered visually distinct from
  satisfied ones) and action buttons: `review-listen`, `review-fix`,
  `review-approve`, `review-discard`.
- `MetadataFixModal` gained a **review mode** (`reviewTracks` input): source
  chips (`data-testid="candidate-source"`, one per `sources[]` entry from
  `gatherCandidates`) alongside the existing candidate list, plus a per-track
  grid (`review-track-title` / `review-track-artist` / `review-track-identify` /
  `review-track-remove` per row) with an album-level `review-identify-album` button
  (fires the majority-vote fingerprint) and `review-save-tracks` (posts to
  `/albums/:id/tracks`). A partial retag failure (some tracks succeeded, some
  didn't) surfaces via a `review.tracksPartial` message and **keeps the modal
  open** rather than closing on a half-success, so the curator can see and
  retry the failed rows.
- **Bulk sweep + mobile layout (issue #592).** The section header carries
  `review-approve-all` / `review-discard-all`. Both are confirmed through
  `ConfirmService` with the queue count named, because prod reached 34 pending
  albums with no way to clear the queue but one card at a time. `runBulk` fans
  out over the *existing* per-album routes rather than a new bulk endpoint:
  each already writes its own audit row, and per-album audit granularity is
  worth more for a destructive mass action than the atomicity one route would
  buy. It runs **sequentially** (34 simultaneous deletes is not a reasonable
  thing to emit) and **never aborts on a failure** — the point of a bulk action
  is not having to retry the remainder by hand — so the outcome is reported as
  `review.bulkDone` or `review.bulkPartial`, and `bulkBusy()` disables both
  buttons for the duration.
  The card itself stacks on a phone (`flex-col … sm:flex-row`): the four
  actions used to sit in a `shrink-0` row whose ~300 px minimum overflowed a
  360 px viewport and clipped **Discard** off the right edge, unreachable.
- The Approve button and the `done`/`skipped` step badges use the shipped
  `.status-done` / `.status-error` **filled pill** classes. They previously used
  `bg-status-success` + `text-white`, and that background utility did not exist —
  see [web-ui.md](web-ui.md) "Theme System" (issue #591) — so on every light
  theme the button was white text on a white card.
- Admin toggle row: `data-testid="processing-hold-for-review"`.
- i18n: `review.*` and `admin.holdForReview*` keys, at `en`/`es` parity.

## e2e notes

`packages/e2e/tests/download-review.spec.ts` is the suite's **first
add-a-file-mid-test flow** (every prior spec only reads/deletes existing
fixtures). It copies a fixture track to a new folder under
`fixtures/music/`, triggers a scan, and exercises approve.

- The suite's config sets `NICOTIND_DISABLE_LANDING_GATE=1` for every other
  spec's sake (so they don't wait on sidecars/ffmpeg); the review predicate
  still holds regardless — that's the point being tested here, not a special
  case to work around.
- Model for triggering a scan mid-test is `auth.setup.ts` (`POST
  /api/system/scan` after seeding fixtures on disk).
- `helpers.ts`'s `preserveMusicFixture` only *restores deletions* — it does
  not help with an *added* file, so this spec removes its own copy in
  `afterEach` (`rmSync` + a follow-up scan to prune the now-gone song from
  the DB) rather than relying on that helper.
- **Fixture choice**: the copied file carries the tags of whichever fixture
  track it's copied from, and (being tag-keyed) quarantines under *that
  fixture's own* `albumId` — which, while pending, hides that whole album
  from every listing (see the quarantine-gate listing coverage in
  [download-pipeline.md](download-pipeline.md)). Copying an `FIXTURE.album`
  track would have hidden the 7-track album that ~15 other spec files assert
  against. This spec copies `FIXTURE.single` instead (used by exactly one
  other spec, `library.spec.ts`), keeping the blast radius of "album briefly
  invisible" to the smallest fixture in the suite.

## Full gate run (task 14)

`bun run typecheck && bun run lint && bun run test && bun run test:web &&
bun run check:claude-md && bun run format:check` all pass, plus the targeted
spec and the full `bun run e2e` suite (one pre-existing, unrelated flake in
`offline.spec.ts` reproduced green in isolation — not caused by this
feature).
