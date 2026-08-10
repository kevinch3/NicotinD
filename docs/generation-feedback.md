# Generation feedback → TDD fixtures

A **dev golden-dataset** primitive: capture whether a _generated / inferred_ NicotinD
output was actually right, straight from real usage, and turn each graded case into a
replayable regression test.

v1 targets the **album-hunt recognizer** — the matching of a MusicBrainz/Lidarr
proposal against raw Soulseek output — because that's where recognition is unreliable
and hardest to test by hand. The primitive is generic (a discriminated
`resourceType`), so radio / generated playlists / library-list / search wire in later
with no schema change.

## The loop

```
admin (dev-mode toggle on) runs an album hunt   ← EITHER hunt path (see below)
   → server snapshots {proposal, raw Soulseek responses, scored candidates}  (pending row)
   → hunt response carries feedbackId → FeedbackService.promptForHunt shows a 👍/👎 toast
   → 👍 = top pick correct   |   👎 = detail sheet: mark the actually-correct folder + note
   → PATCH /api/feedback/:id  grades the pending row (verdict good/bad + itemFlags)
   ↕ ungraded rows also accumulate in Admin → "Generation feedback" (30-day window)
scripts/feedback-to-fixtures.ts  → packages/api/src/services/__fixtures__/hunt-match/<id>.json
album-hunter.replay.test.ts  → re-runs the PURE recognizer offline, asserts the
                                human-correct folder ranks #1  (red/green)
```

### The two hunt paths both prompt

There are **two** ways a hunt runs, and both create a capture row because both call
`POST /albums/:id/hunt/base`:

| Path                      | Entered by                                           | Prompts via                       |
| ------------------------- | ---------------------------------------------------- | --------------------------------- |
| `AutoHuntService`         | the "Get" button on a catalog album (the common one) | `_promptFeedback` on each outcome |
| `AlbumHuntModalComponent` | "Find Manually" / "Choose Manually"                  | after `startHunt()` resolves      |

Both call the **same** `FeedbackService.promptForHunt(ctx)` — the admin + dev-toggle gate,
the one-per-id throttle, the toast and the 👎 sheet all live there, so a third caller can
never re-implement half of it.

### Why it never fired (issue #451)

Shipped, the loop produced **zero** graded rows. Measured on prod: the admin's toggle was
on, `generation_feedback` AUTOINCREMENT was at **39**, and every row was ungraded. The
capture half worked; the prompt half had three defects:

1. `AutoHuntService` — the path nearly every hunt takes — called `huntAlbumBase` (creating
   the row) but never injected `FeedbackService`. Only the fallback modal prompted.
2. `shouldPrompt()` consumed the id **before** `toast.show()`, and `ToastService` silently
   drops a toast while 3 countdown toasts are live — exactly what auto-hunt emits. A
   dropped prompt was never re-offered. `shouldPrompt` is now a pure check and
   `markPrompted()` runs only once the toast is confirmed on screen.
3. A 12-second toast was the **only** surface, and the pending TTL was 24 hours — so a
   missed prompt meant a deleted capture. Hence the Admin queue + the 30-day window.

Guard rails now in place: `discography.hunt-feedback.test.ts` pins the `feedbackId`
contract (previously asserted nowhere — the field is hand-declared client-side in
`api-types.ts`), `auto-hunt.service.spec.ts` pins the prompt on every terminal outcome, and
`packages/e2e/tests/generation-feedback.spec.ts` covers the toggle + queue.

## Admin review queue

`GET /api/feedback/summaries` (admin) backs `pages/admin/feedback-queue/` — a
`SettingsGroupComponent` that loads on its `opened` output, **not** on the `ServiceReview`
5-second poll (it's an on-demand dev list, not live status). It deliberately does not reuse
`listFeedback`: that parses `output_json`, and one real prod row is **251 KB**, so a
100-row queue would ship ~25 MB. `GenerationFeedbackSummary` carries display fields only;
👎 then fetches the one full record via `GET /api/feedback/:id` because the grading sheet
needs the scored candidates. The full-export `GET /api/feedback` is untouched —
`scripts/feedback-to-fixtures.ts` depends on its shape.

The `feedback_capture` toggle write (`POST /api/auth/feedback-capture`) is an upsert: as a
bare `UPDATE` it no-opped for a user with no `user_settings` row while still returning
`{ok:true}`, so the client showed the switch on and the next `/me` flipped it back off.

## Why it's replayable — the recognizer refactor

`AlbumHunterService.searchAndScore` was split into:

- **`scoreFolders(canonicalTracks, responses)`** — pure, IO-free: group raw slskd
  responses into folders, score against the tracklist, rank, cap at 20. This is the
  exact function a fixture replays. (`packages/api/src/services/album-hunter.service.ts`)
- **`search(queries)`** — the network half (create/poll/cleanup) returning the raw
  `ScoreResponse[]`.

`huntBase` now returns `{ candidates, skewNeeded, responses }` — the **raw responses**
(including sub-floor folders the recognizer dropped) are what make an offline replay
faithful. That's the whole point: a 👎 fixture can prove a _fix_ now ranks the
previously-missed folder #1.

## Data model

`generation_feedback` (`packages/api/src/db.ts`): `verdict` NULL = pending (captured at
hunt time, ungraded); `input_json` / `output_json` hold the full snapshot; `item_flags_json`
holds the human truth (`correctFolder`); `engine_version` stamps the app version so replay
can spot scorer drift. Indexed on `(resource_type, at DESC)`.

`user_settings.feedback_capture` — the per-user admin dev-mode toggle (default 0).

## Snapshot shapes

Typed in `@nicotind/core` (`types/generation-feedback.ts`, re-exported to web via
`packages/web/src/types/core.ts`):

- `HuntMatchInput` — the proposal: artist/album, `lidarrAlbumId`, `releaseGroupMbid`
  (`album.foreignAlbumId`), `artistMbid` (`album.artist.foreignArtistId`), `canonicalTracks`.
- `HuntMatchOutput` — `rawResponses` (verbatim slskd), `candidates` (scored), `chosen`.
- `HuntMatchItemFlags` — `correctFolder` (null = "none of these"), `wrongCandidates`.
- `HuntMatchFixture` — `{ canonicalTracks, rawResponses, expected.correctFolder, meta }`.

## Persistence + gating

`packages/api/src/services/generation-feedback.ts` (mirrors `recordAudit` — writes are
try/catch-guarded, never break the generation they wrap):

- `recordPendingFeedback` — insert a pending row (opportunistically prunes stale pending
  rows past `PENDING_TTL_MS` = **30 days**). Returns the row id (0 on failure = no toast).
- `captureHuntMatchFeedback` — **the gate**: records only when the requester is an admin
  with `feedback_capture` on. Recording for every hunt would fill the table with
  never-graded rows.
- `resolveFeedback` — grade a pending row (owner-only, pending-only).
- `listFeedback` / `feedbackCaptureEnabled` / `huntFixtureFromRecord` — export + gate + distill.
- `listFeedbackSummaries` / `getFeedback` — the review queue's reads (see above). Both share
  `buildListQuery` with `listFeedback` so their filters can't drift.

## Capture seam

Both hunt paths use the two-phase `hunt/base` + `hunt/skew`. Capture is anchored
on **`POST /api/discography/albums/:id/hunt/base`** (`routes/discography.ts`) — it already
holds `album` (proposal + MBIDs) + `tracks` (canonical tracklist), and `huntBase` now
surfaces the raw responses. The route builds the `HuntMatchInput`, calls
`captureHuntMatchFeedback`, and returns `feedbackId` when gated in.

**v1 limitation (documented):** only the _base-phase_ responses are snapshotted; a folder
surfaced solely by a skew variant won't be in the replay corpus's raw responses (the 👎
sheet still records it as a note/correctFolder). Merging skew responses into the same row,
and capturing the unattended `acquireAlbum` path (which already has proposal + un-truncated
candidates + MBID in one scope), are follow-ups.

## API

Admin-only (`routes/feedback.ts`, mounted at `/api/feedback`):

- `PATCH /api/feedback/:id` — `{ verdict: 'good'|'bad', note?, itemFlags? }`; 404 if no
  pending row owned by the caller; audited via `recordAudit('feedback.resolve')`.
- `GET /api/feedback?resourceType=&graded=&limit=&offset=` — export.

Toggle: `POST /api/auth/feedback-capture { enabled }`; surfaced on `GET /api/auth/me` as
`feedbackCapture`.

## Web

- `FeedbackService` — `resolve(id, verdict, opts)` PATCH + `shouldPrompt(feedbackId)`
  throttle (one toast per hunt event).
- `album-hunt-modal` — `maybePromptFeedback` shows the 👍/👎 toast when admin +
  `feedbackCapture` and a `feedbackId` came back.
- `FeedbackSheetService` + `FeedbackDetailSheetComponent` (mounted in the layout) — the 👎
  "which folder was actually correct?" picker (or "none of these") + note.
- Settings → **Developer** (admin-only) → "Capture generation feedback" toggle.

## Extending to another resource

1. Add the `resourceType` literal + snapshot types in `types/generation-feedback.ts`.
2. Capture at the generator's input→output seam (radio/playlist can `POST` a complete
   snapshot client-side since the client holds the result; only hunt needs the
   server-pending path because raw Soulseek responses are server-only).
3. Add a `<resource>FixtureFromRecord` distiller + a replay test over the pure engine
   (`rankCandidates` for radio/playlist, `orderTracks` for sequencing).
