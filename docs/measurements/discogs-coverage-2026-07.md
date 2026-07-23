# Discogs genre-coverage spike — 2026-07

**Issue:** [#191](https://github.com/kevinch3/NicotinD/issues/191). A throwaway
measurement that decides whether the Discogs genre integration is worth
building. No plugin code ships from this issue — only this report.

**Status: harness landed; live measurement PENDING a manual run.** The
measurement script and its unit-tested pure parts are committed and run in CI;
the **live API run is manual and out of CI** (it needs a Discogs Consumer Key +
Secret and the real production library), so the result table below is a
scaffold to fill in — its numbers are placeholders (`—`), **not** measured
values. Do not read the table as data until an admin runs the harness and
replaces this section. (Running it here was not possible: no Discogs credentials
and no access to the production library from CI.)

## Why this spike exists

#187 measured MusicBrainz genre coverage empirically, and those numbers drove
every subsequent design decision (artist-level **2/25 ≈ 3%**; release-group
**8/12 ≈ 67%**). Discogs is hypothesised to beat both for **Latin / regional /
pre-2000 / DJ-pool** repertoire — the exact gap #187's A1 could not close (José
Larralde still resolves to `Latin;World`, not `Folk`/`Chamamé`). Building three
capabilities, a provider-chain refactor and a task restructure before testing
that hypothesis would be backwards, so this measures it first.

## The measurement

- **Script:** [`packages/api/src/scripts/measure-discogs-coverage.ts`](../../packages/api/src/scripts/measure-discogs-coverage.ts)
  — dev-only, read-only, admin-run. Self-contained (no dependency on the #193
  plugin).
- **Sample:** the **residual gap** — albums that still own a genre-less landed
  song after A1 (`library_songs.genre IS NULL`), drawn from the live library
  most-affected-first (`--limit`, default 25), plus the two fixed **named
  regression anchors** below so the numbers stay directly comparable to #187.
- **Per case:** MBID-first (MusicBrainz's own `discogs` url-relation → the
  Discogs release/master) when an album MBID is on record, else a **corroborated
  name search** (artist **and** album title must both match — album-title
  corroboration is what rejects the same-name Emilia false pair).

### How to run it

```bash
# 1. Register a free app at discogs.com/settings/developers (Consumer Key + Secret).
# 2. Point the env at the library and run against the real DB:
DISCOGS_KEY=…  DISCOGS_SECRET=…  NICOTIND_DATA_DIR=~/.nicotind \
  bun run packages/api/src/scripts/measure-discogs-coverage.ts \
    --limit 25 --out docs/measurements/discogs-coverage-2026-07.md
```

The script self-throttles to ~55 req/min (Discogs is 60/min with a key + secret,
25 anonymous, and gives no `Retry-After` on a 429) and reports the requests
consumed + wall-clock so the rate-limit budget can be sized honestly.

## Pass criterion — marginal coverage, not parity

Parity with MB is worth zero (we already have MB). The decision-relevant number
is: **of the songs still genre-less after A1, how many does Discogs resolve?**

| Cohort                                        | Resolved |
| --------------------------------------------- | -------- |
| Songs genre-less after A1 (the residual gap)  | —        |
| …of those, resolved by Discogs release genres | —        |
| …of those, resolved by Discogs release styles | —        |
| …of those, resolved by either                 | —        |

**Budget (fill from the run):** — requests, — s wall-clock.

## Named cases (to check explicitly)

- **José Larralde** — does Discogs carry Folk / Folclore / Chamamé? This is
  #187's unmet A1 acceptance criterion and the canonical "does this help where MB
  didn't?" test. → _pending._
- **Emilia (Argentine)** — does MBID-first + album-title corroboration prevent
  the Swedish-Emilia false match that reproduced during #187's measurement? (The
  harness's `pickBestHit` rejects a right-artist/wrong-album hit; unit-tested.)
  → _pending._

## Verdict gate

- **Pass** (Discogs resolves a materially larger share of the residual gap than
  is already covered) → the album-scoped genre enrichment issue proceeds: wire
  the #193 `genre` capability into the windowed processor + the
  `library_genre_overrides` write path.
- **Fail** → close the genre issue as `wontfix`. The remaining Discogs value
  (images, bios) is marginal and probably doesn't justify the extra capabilities.

→ _verdict: **pending the manual run.**_

## Relationship to #187 / #193

This measures an alternative source for **#187 Task A1** (trusted-metadata
genre); it does not replace A1 (PR #188 already shipped MusicBrainz release-group
genres + the A3 override write path). Discogs would be a _second_ provider behind
the same `library_genre_overrides` gate. The **plugin shell** (client, matching,
`genre` capability) landed in **#193** — this spike decides whether that shell
gets wired into background enrichment at all. #187 stays open for A2 (Essentia
genre head), B3, B4, B5.
