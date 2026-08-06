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
| `POST /albums/:id/approve` | Records an `approved` decision, audits `download_review.approve`, nudges `kickEager()` so landing isn't waiting on the next window tick. Idempotent (upsert on `album_id`). |
| `POST /albums/:id/discard` | Runs the **shared** `deleteAlbum` (same function library delete + the MCP delete tool use — `services/library-deletion.ts`), then records a `discarded` decision, audits `download_review.discard`. |
| `POST /songs/:id/identify` | Fingerprint one track via the enabled `identify` plugin (AcoustID). 503 if no plugin/music dir configured. |
| `POST /albums/:id/identify` | Fingerprints up to 5 quarantined tracks for the album sequentially (rate-limit-friendly), returns each track's result plus a majority-vote album guess (`voteAlbumIdentity`: needs ≥2 votes **and** more than half of successful results to agree — a lone match or a tie suggests nothing). |
| `POST /albums/:id/tracks` | Per-track retag (title/artist), writes tags to the file, then an incremental rescan. A track with no fields to update fails with `'No fields to update'`; other tracks in the same request still get written (partial success surfaces per-track). Audits `download_review.retag`. |

All routes require `requireCurator` — role gating detail below.

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
(`identifyTrack(path): Promise<IdentifyResult | null>`). Config is
`{ apiKey, binaryPath }`; availability is probed by spawning the local
`fpcalc` binary with `-version` (never a real fingerprint call, so the probe
is cheap and offline-safe). **Promotion note**: `createApp`'s legacy
`acoustidApiKey` secrets option (previously dead weight with no consumer) now
seeds the plugin's `apiKey` at registration time
(`registerBuiltinPlugins` → `new AcoustidPlugin({ apiKey: acoustidApiKey ?? '' })`)
— an existing deployment that had already set this secret gets AcoustID
identify for free without re-entering a key.

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
