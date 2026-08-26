# Curation pass — 2026-08 (calibration + tooling baseline)

Not yet a full playbook pass — the tooling (health report + MCP parity tools, PRs #739–#742)
landed this month; the first full Wave 0–5 pass runs once they deploy. This record holds the
**Step-0 calibration probes** (read-only, prod `kpc`, 2026-08-26) that froze the detector
thresholds, so the first real pass has a before-picture.

## Library totals (2026-08-26)

2,966 artists · 5,181 albums (5,173 visible) · 16,386 songs.

## Baseline per dimension

| Dimension | Measured | Note |
| --- | --- | --- |
| Album canonical covers | **2,691 / 5,173 visible missing (52%)** | grown from #694's 2,561; `artwork-backfill` is Wave 1's biggest lever |
| Missing years | 215 visible albums | |
| Visible `unknown` classification | 0 | the curator holds |
| Genre-less songs (landed) | 902 | residue after the 08-25/26 manual passes |
| Lyrics coverage | 1,476 / 16,386 (9%) | informational — fetch is on-demand by design |
| Open curation flags | 11 | ~4 researched, resolvable once `resolve_review_flag` deploys |
| Mixed-format albums | 238 | flac+mp3 / mp3+opus mixes; several look like duplicate-rip inflation |
| Low-bitrate albums (128/96 floors) | **15** | floors deliberate: a 160 floor would flag 39% of all mp3s |
| Lossless remaining | 518 songs (all flac) | = `transcode-library`'s candidate set |
| Zero-bitrate rows | 8 | probe failures — why "known bitrate" means `> 0` |
| Completeness, confirmed population | 440 done + 50 exhausted `album_jobs` (406 unique pairs) | expected-vs-owned computed per pair at report time |
| Completeness, suspected (track gaps) | **463** guarded (1,627 unguarded) | guards: distinct numbers, ≥3 owned, `maxTrack ≤ 40`; survivors sampled real (Dark Side of the Moon 8/9, Midnights 12/13) |

## Format histogram (context for the floors)

mp3 11,192 (avg 198 kbps; 40 below 128) · opus 4,402 (avg 188; 127 below 128, 4 below 96) ·
flac 518 · m4a 225 · ogg 43 · wma 6.

## Decisions frozen from these numbers

- Low-bitrate floors **128 kbps lossy / 96 kbps opus**, album flagged at ≥½ of known-bitrate
  tracks below floor, `bit_rate <= 0` = unknown.
- Suspected track-gap guards as above; bucket is **advisory-only**.
- Health report is on-demand only (never a ServiceReview slice).

## Next

First full pass (Waves 0–5) after the #739–#742 stack deploys; record it as
`curation-pass-2026-09.md` unless run before the month rotates.
