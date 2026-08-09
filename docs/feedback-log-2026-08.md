# Real-use feedback log — August 2026

**Period:** 2026-08-01 → (rolling)
**Purpose:** Capture issues and friction observed while actually _using_ NicotinD (not synthetic tests). One entry per observation; route each to a fix (PR/workstream) or an existing finding. Previous window: [feedback-log-2026-07.md](feedback-log-2026-07.md).

> How to use this log: add a dated bullet whenever something annoys you in real use — even small. Tag **Severity** (High/Medium/Low) and **Status** (◻️ open / ◑ partial / ✅ fixed). When a theme repeats across days, it's a prioritization signal. Rotate monthly (`feedback-log-YYYY-MM.md`).

---

## TL;DR (this window)

| #   | Status | Severity | Flow                | Issue                                                      |
| --- | ------ | -------- | ------------------- | ---------------------------------------------------------- |
| 1   | ✅     | High     | Generation feedback | The 👍/👎 grading prompt had never once appeared to a user |

---

## Entries

### 2026-08-09

- **(High) Generation feedback: nobody has ever seen the grading prompt — and it wasn't clear when it was supposed to appear.** _Use:_ the album-hunt golden-dataset loop (`docs/generation-feedback.md`) had produced zero fixtures since it shipped, and the trigger conditions weren't discoverable from the UI. _Measured first (prod `kpc`, read-only):_ the admin's `feedback_capture` toggle was **on**, `generation_feedback` AUTOINCREMENT was at **39** (≈39 hunts snapshotted), and **every** row was ungraded — only 2 survived, the rest deleted by the 24-hour pending TTL. So server capture worked; the prompt half didn't. _Root cause:_ the "Get" button on a catalog album runs `AutoHuntService`, which calls `huntAlbumBase` (creating the capture row) but never injected `FeedbackService` — the only code that prompted was the fallback `AlbumHuntModalComponent`. Compounding: `shouldPrompt()` consumed the feedback id **before** `toast.show()`, which silently drops a toast while 3 countdown toasts are live (exactly what auto-hunt emits); and a 12-second toast was the only surface, with a 24 h TTL deleting anything missed. Nothing caught it — the modal spec had zero feedback assertions, no server test covered the `feedbackId` contract, and no e2e spec referenced any feedback testid. **✅ Fixed** (issue #451): one shared `FeedbackService.promptForHunt` called by both hunt paths; `shouldPrompt` split into a pure check + `markPrompted()` that runs only once the toast is confirmed on screen; a durable **Admin → "Generation feedback" review queue** (`GET /api/feedback/summaries` + `GET /api/feedback/:id`); pending TTL 24 h → 30 days; and the `feedback_capture` write upserted (as a bare `UPDATE` it no-opped for a user with no `user_settings` row while still returning ok). → `docs/generation-feedback.md`.

  _Lesson worth keeping:_ the feature was designed as one continuous path (hunt → toast → grade) but the app has **two** hunt paths, and only one was wired. A capture-then-prompt design should treat "captured but never graded" as an observable failure state — the Admin queue now makes it one.

---

## Aggregated themes (window total)

| Theme                                     | Count | Severity | Related                        |
| ----------------------------------------- | ----- | -------- | ------------------------------ |
| Feature wired on only one of N call paths | 1     | High     | item 1; generation-feedback.md |

## Next steps / watch-list

- After deploy, re-probe prod: `generation_feedback` should start showing rows with a non-NULL `verdict`. A still-zero graded count means the prompt is still not reaching anyone.
- Once a few real 👎 rows exist, run `scripts/feedback-to-fixtures.ts` + `album-hunter.replay.test.ts` — the loop has never actually been closed end to end with real data.
