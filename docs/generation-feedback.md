# Generation feedback → TDD fixtures

A **dev golden-dataset** primitive: capture whether a *generated / inferred* NicotinD
output was actually right, straight from real usage, and turn each graded case into a
replayable regression test.

v1 targets the **album-hunt recognizer** — the matching of a MusicBrainz/Lidarr
proposal against raw Soulseek output — because that's where recognition is unreliable
and hardest to test by hand. The primitive is generic (a discriminated
`resourceType`), so radio / generated playlists / library-list / search wire in later
with no schema change.

## The loop

```
admin (dev-mode toggle on) runs an album hunt
   → server snapshots {proposal, raw Soulseek responses, scored candidates}  (pending row)
   → hunt response carries feedbackId → client shows a 👍/👎 capture toast
   → 👍 = top pick correct   |   👎 = detail sheet: mark the actually-correct folder + note
   → PATCH /api/feedback/:id  grades the pending row (verdict good/bad + itemFlags)
scripts/feedback-to-fixtures.ts  → packages/api/src/services/__fixtures__/hunt-match/<id>.json
album-hunter.replay.test.ts  → re-runs the PURE recognizer offline, asserts the
                                human-correct folder ranks #1  (red/green)
```

## Why it's replayable — the recognizer refactor

`AlbumHunterService.searchAndScore` was split into:

- **`scoreFolders(canonicalTracks, responses)`** — pure, IO-free: group raw slskd
  responses into folders, score against the tracklist, rank, cap at 20. This is the
  exact function a fixture replays. (`packages/api/src/services/album-hunter.service.ts`)
- **`search(queries)`** — the network half (create/poll/cleanup) returning the raw
  `ScoreResponse[]`.

`huntBase` now returns `{ candidates, skewNeeded, responses }` — the **raw responses**
(including sub-floor folders the recognizer dropped) are what make an offline replay
faithful. That's the whole point: a 👎 fixture can prove a *fix* now ranks the
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
  rows past `PENDING_TTL_MS` = 24h). Returns the row id (0 on failure = no toast).
- `captureHuntMatchFeedback` — **the gate**: records only when the requester is an admin
  with `feedback_capture` on. Recording for every hunt would fill the table with
  never-graded rows.
- `resolveFeedback` — grade a pending row (owner-only, pending-only).
- `listFeedback` / `feedbackCaptureEnabled` / `huntFixtureFromRecord` — export + gate + distill.

## Capture seam

The interactive modal uses the two-phase `hunt/base` + `hunt/skew`. Capture is anchored
on **`POST /api/discography/albums/:id/hunt/base`** (`routes/discography.ts`) — it already
holds `album` (proposal + MBIDs) + `tracks` (canonical tracklist), and `huntBase` now
surfaces the raw responses. The route builds the `HuntMatchInput`, calls
`captureHuntMatchFeedback`, and returns `feedbackId` when gated in.

**v1 limitation (documented):** only the *base-phase* responses are snapshotted; a folder
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
