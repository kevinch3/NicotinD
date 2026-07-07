# Real-use feedback log — July 2026

**Period:** 2026-07-01 → (rolling)
**Purpose:** Capture issues and friction observed while actually *using* NicotinD (not synthetic tests). One entry per observation; route each to a fix (PR/workstream) or an existing finding. Previous window: [feedback-log-2026-06.md](feedback-log-2026-06.md).

> How to use this log: add a dated bullet whenever something annoys you in real use — even small. Tag **Severity** (High/Medium/Low) and **Status** (◻️ open / ◑ partial / ✅ fixed). When a theme repeats across days, it's a prioritization signal. Rotate monthly (`feedback-log-YYYY-MM.md`).

---

## TL;DR (this window)

| # | Status | Severity | Flow | Issue |
|---|--------|----------|------|-------|
| 1 | ✅ | High | Player (Firefox) | Tracks intermittently never play — third distinct root cause (self-aborting load-effect loop) after the Content-Length and ngsw-bypass fixes |

---

## Day-by-day

### 2026-07-07

- **(High) Firefox: some tracks never play — again, after two same-day fixes.** *Use:* on Firefox for Mac, "TIEMPO OFF" and "LABIOS APILADOS" (CUERPOS, Vol. 1) alternated pause icon/spinner forever while the rest of the album played; felt tied to "OPUS transcoded files". *Root cause (third, distinct from PR #87's Content-Length and PR #88's ngsw-bypass):* `setBuffering(true)`'s guard read `bufferingVisible()` inside PlayerComponent's track-load effect, silently subscribing the effect to the 250 ms spinner timer — any load slower than 250 ms to first byte (fresh ffmpeg transcode ≈ 4 s, proxy latency) re-ran the effect, re-assigned `audio.src`, and aborted its own request in a ~300 ms loop. Not the codec: the *fresh-transcode latency* was the trigger, which is why cached tracks played. Diagnosed by instrumenting `HTMLMediaElement` in Playwright Firefox against prod. **✅ Fixed:** `untracked()` around the guard read + regression test; verified master-vs-fix behind a 900 ms delay proxy. → `docs/web-ui.md` (bug #3).

  *Lesson for the log:* three "Firefox never plays" bugs shipped/manifested within one day of the loading-feedback feature. When a symptom recurs after a fix, treat it as a *new* root cause until proven otherwise — all three had different mechanisms (response headers, service worker, signal graph).

---

## Aggregated themes (window total)

| Theme | Count | Severity | Related |
|-------|-------|----------|---------|
| Playback reliability (Firefox) | 1 | High | item 1; web-ui.md bugs #1–#3 |

## Next steps / watch-list

- After deploy, re-test the two named tracks on Firefox for Mac *through the public URL* (the localhost path never reproduced it).
- Watch for any further "never plays" reports — if a fourth appears, audit every `PlayerService` setter for tracked reads (the constraint is now documented in web-ui.md).
