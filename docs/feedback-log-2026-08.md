# Real-use feedback log — August 2026

**Period:** 2026-08-01 → (rolling)
**Purpose:** Capture issues and friction observed while actually _using_ NicotinD (not synthetic tests). One entry per observation; route each to a fix (PR/workstream) or an existing finding. Previous window: [feedback-log-2026-07.md](feedback-log-2026-07.md).

> How to use this log: add a dated bullet whenever something annoys you in real use — even small. Tag **Severity** (High/Medium/Low) and **Status** (◻️ open / ◑ partial / ✅ fixed). When a theme repeats across days, it's a prioritization signal. Rotate monthly (`feedback-log-YYYY-MM.md`).

---

## TL;DR (this window)

| #   | Status | Severity | Flow                | Issue                                                      |
| --- | ------ | -------- | ------------------- | ---------------------------------------------------------- |
| 1   | ✅     | High     | Generation feedback | The 👍/👎 grading prompt had never once appeared to a user |
| 2   | ✅     | High     | One-click Get       | Every one-click album download failed with a generic toast |
| 3   | ✅     | Medium   | Downloads feed      | Cards show "?Unknown source" for Soulseek addon jobs       |
| 4   | ✅     | Medium   | Downloads feed      | Old download cards can't be removed (silent no-op)         |
| 5   | ✅     | Medium   | Ingest transcode    | Glitchy FLACs rejected with opaque "code 183", kept as FLAC |

---

## Entries

### 2026-08-09

- **(High) Generation feedback: nobody has ever seen the grading prompt — and it wasn't clear when it was supposed to appear.** _Use:_ the album-hunt golden-dataset loop (`docs/generation-feedback.md`) had produced zero fixtures since it shipped, and the trigger conditions weren't discoverable from the UI. _Measured first (prod `kpc`, read-only):_ the admin's `feedback_capture` toggle was **on**, `generation_feedback` AUTOINCREMENT was at **39** (≈39 hunts snapshotted), and **every** row was ungraded — only 2 survived, the rest deleted by the 24-hour pending TTL. So server capture worked; the prompt half didn't. _Root cause:_ the "Get" button on a catalog album runs `AutoHuntService`, which calls `huntAlbumBase` (creating the capture row) but never injected `FeedbackService` — the only code that prompted was the fallback `AlbumHuntModalComponent`. Compounding: `shouldPrompt()` consumed the feedback id **before** `toast.show()`, which silently drops a toast while 3 countdown toasts are live (exactly what auto-hunt emits); and a 12-second toast was the only surface, with a 24 h TTL deleting anything missed. Nothing caught it — the modal spec had zero feedback assertions, no server test covered the `feedbackId` contract, and no e2e spec referenced any feedback testid. **✅ Fixed** (issue #451): one shared `FeedbackService.promptForHunt` called by both hunt paths; `shouldPrompt` split into a pure check + `markPrompted()` that runs only once the toast is confirmed on screen; a durable **Admin → "Generation feedback" review queue** (`GET /api/feedback/summaries` + `GET /api/feedback/:id`); pending TTL 24 h → 30 days; and the `feedback_capture` write upserted (as a bare `UPDATE` it no-opped for a user with no `user_settings` row while still returning ok). → `docs/generation-feedback.md`.

  _Lesson worth keeping:_ the feature was designed as one continuous path (hunt → toast → grade) but the app has **two** hunt paths, and only one was wired. A capture-then-prompt design should treat "captured but never graded" as an observable failure state — the Admin queue now makes it one.

### 2026-08-18

- **(High) One-click "Get" on catalog albums always fails — "Finding… → Best match found → Download failed" with no reason, on every album.** _Use:_ Jason Mraz discography on prod; only the manual hunt modal worked. _Measured first (prod `kpc`, read-only):_ zero `acquisition_jobs` rows and zero addon jobs for the failed clicks — the failure was core-side, pre-enqueue, and the logs were **silent**. _Root cause:_ the addon cutover made `hunt-download` require `selected.candidateRef` (400 "Selection expired" without it); the manual modal was migrated, `AutoHuntService` wasn't — and both the web toast and the server flattened/skipped the reason, so a 100%-reproducible regression shipped invisible. **✅ Fixed** (issues #530/#531): candidateRef sent; bounded 3-attempt auto-retry across candidates on retriable (5xx) failures with narrated hops; the classifier carries the server body message, the toast shows it, every server failure branch logs. _Lesson:_ a seam migration with two callers needs a test on **each** caller, and error flattening at two layers turns a hard failure into a silent one — surfacing raw reasons is what makes this class self-diagnosing.
- **(Medium) Downloads feed shows "?Unknown source" on Soulseek downloads.** `methodForBackend` never mapped the slskd addon id, so every post-cutover hunt card fell to the `unknown` badge while the "Soulseek" badge sat unused. **✅ Fixed** (issue #532).
- **(Medium) "A lot of old downloads that I can't remove but don't fail."** `DELETE /jobs/:id` 400'd on any row without an `addon:` source_ref (all pre-cutover rows + url mirrors), pointing at per-transfer routes deleted in phase 3, and the web swallowed the error — Remove/Clear finished silently no-opped. **✅ Fixed** (issue #533): core row always deletable, addon proxy best-effort, failures toasted. The stranded prod rows need no manual cleanup (removable now; 7-day TTL regardless).
- **(Medium) 19 warnings "ffmpeg exited with code 183" — the whole album kept as FLAC instead of Opus.** Strict `-err_detect explode` rejected rips with one damaged frame (decode fine leniently — reproduced in the prod container: `invalid sync code`), and `stdio: 'ignore'` threw the reason away. **✅ Fixed** (issue #534): stderr tail in the error + lenient retry gated on the existing duration validation.

### 2026-08-20

- **(High) Spotify playlist → one card "Spotify download · Done 1 of 1", one track of the whole playlist — and this worked before the extension split.** _Measured first (prod `kpc`, read-only):_ the spotdl addon's staging dir for the job held exactly one file; older jobs from two days earlier held 70–80 folders, so the addon lane *can* do whole playlists; the spotdl **pot-provider** sidecar had minted ~30 PO tokens in the window, so spotDL attempted the whole playlist and died partway; the addon's own `docker logs` were **empty**, and its `jobs.db` had 0 rows after "Cancel all". _Root cause:_ both downloader addons spawn with `stdio: 'ignore'` and glob staging — the playlist name, the expected total and the per-track order only exist on that discarded stream, so a partial is reported as a complete job under the source label (yt-dlp identical; bundled archive immune). **Fix in flight** (issue #585, PR #582 + one PR per addon repo): SDK-shared parsers, `AddonJob.title`, per-track items with `unavailable` placeholders up to the announced total, `partial` + real error lines, downloader output logged; core sends the playlist classification (`resolveAcquireAs`). The URL itself was lost with the row, so the *spotDL-side* reason for the failure is still unknown until the next run has a transcript. _Lesson:_ `stdio: 'ignore'` on a long-running external tool is the same "throw the evidence away" shape as the ffmpeg code-183 entry two days earlier — third time this month a silent subprocess hid a 100 %-reproducible failure.
- **(Medium) "Cancel all" can't remove a stuck "Kaleo · Downloading 0 of 31" Soulseek card (4 h old, files long landed).** _Measured:_ one `kind='direct'` row with `source_ref='mellowwillow'` and 31 items still `downloading`; core logged `cancel requested for a non-addon job` on every click; the poller had separately mirrored the same browse-grab into its own row (`dccf09ac…`), which got the files and was cleared. _Root cause:_ the raw-lane route discarded the addon job id, so one grab = two cards and the visible one was unowned. **✅ Fixed** (issue #586): `DownloadReceipt` links the row + pre-maps the poller; Cancel on an unowned row closes it core-side. The existing prod row clears with one Cancel after deploy.

---

## Aggregated themes (window total)

| Theme                                     | Count | Severity | Related                        |
| ----------------------------------------- | ----- | -------- | ------------------------------ |
| Feature wired on only one of N call paths | 1     | High     | item 1; generation-feedback.md |
| Silent subprocess (`stdio: 'ignore'`) hides a reproducible failure | 2 | High | ffmpeg 183 (#534); addon stdout (#585) |

## Next steps / watch-list

- After deploy, re-probe prod: `generation_feedback` should start showing rows with a non-NULL `verdict`. A still-zero graded count means the prompt is still not reaching anyone.
- Once a few real 👎 rows exist, run `scripts/feedback-to-fixtures.ts` + `album-hunter.replay.test.ts` — the loop has never actually been closed end to end with real data.
