# Radio evaluation polls

Admin-created, public, anonymous grading of the smart-radio engine's next-track
picks — the human-judgment counterpart to the developer-only diagnostic
`dump-radio.ts` ([radio.md](radio.md)).

## What it is

An admin creates a **poll**: the server generates N frozen **scenarios**, each a
seed song ("Now playing: Eleanor Rigby — The Beatles") plus K next-up
suggestions produced by the real radio engine (`buildSeedRadio`, no listener
recency since there is no listener), snapshotted **with per-axis similarity
explanations**. The admin gets a public URL (`/poll/<token>`). Anyone with the
link walks a wizard that emulates the Now Playing screen — cover art and
playable previews included — and thumbs 👍/👎 **each suggested track
individually**. Every vote is therefore a `(seed, candidate, verdict)` triple
that lines up exactly with the stored `SimilarityExplanation`, which is what
makes the output usable for weight tuning later.

## Why snapshots are mandatory

Every radio pool query is `ORDER BY RANDOM()`: two generations from the same
seed return different queues. A poll where each visitor graded a fresh queue
would produce votes that can't be aggregated. So scenarios are **frozen at
creation** (`radio_poll_scenarios.snapshot_json`: seed + candidates with full
`Song` rows, features, score, rank, explanation, and the exact weight set used)
and every rater grades the same queues. The snapshot is also what keeps the
admin results and the export self-contained after songs are deleted or
re-scanned — only *playback* can 404 afterwards, and the wizard treats a failed
audio load as a note, never a broken step.

Snapshot hygiene: `stripFeatures` removes `embedding` (a `Float32Array`, which
`JSON.stringify` would mangle into an index-keyed blob) and `recentPlayFactor`
(listener-relative) before persisting — unit-tested, because forgetting it is
silent data corruption.

## Data model

Three tables (`packages/api/src/db.ts`): `radio_polls` (token UNIQUE — the
credential; `created_by` cascades from users and is registered for privacy
export/erasure; `formula_version` stamps which `RADIO_FORMULA_VERSION` of the
similarity formula generated the scenarios — issue #583: votes graded under
different formulas must never be silently pooled, and NULL means a
pre-versioning row, i.e. formula 1), `radio_poll_scenarios` (position-ordered
snapshots), and
`radio_poll_votes` with `UNIQUE (scenario_id, rater_key, candidate_song_id)` +
upsert — a rater changing their mind updates in place, never double-counts.

**Anonymity**: `rater_key` is a random per-device UUID the browser keeps in
localStorage (`nicotind.pollRaterKey`). It is deliberately NOT a users FK and
ties to nothing; it exists only so a returning visitor updates their own votes.
Polls got their **own tables** rather than `generation_feedback` rows because
that ledger is one-authenticated-admin-per-row while a poll is anonymous
multi-rater ([generation-feedback.md](generation-feedback.md) stays the home of
the single-grader loop; `resourceType: 'radio'` remains reserved for it).

## Route split + auth posture

Two factories in `routes/radio-polls.ts`, mounted separately on purpose:

- **Admin half** at `/api/admin/radio-polls` — covered by the blanket
  `/api/admin/*` auth prefix, `requireAdmin` per handler, every mutation
  audit-logged (`radio-poll.create`/`close`/`delete`). Create generates +
  freezes scenarios in one transaction; `GET /:id` is the diagnosis surface
  (full snapshots incl. explanations + per-candidate tallies).
- **Public half** at `/api/radio-polls` — a reasoned `PUBLIC_ROUTES` entry in
  `scripts/check-route-auth.ts`; the poll token is the credential. Keeping the
  public group minimal means a future route added to the wrong file trips the
  gate instead of silently shipping unauthenticated.

The public endpoints must **never 401**: the web auth interceptor bounces any
401 to `/login`, which would eject an anonymous rater mid-wizard. Unknown token
→ 404; closed/expired → **410** with `code: POLL_CLOSED | POLL_EXPIRED` so the
page renders a distinct state.

## Media access (previews)

`GET /public/:token` mints a fresh **share-scoped JWT** per call
(`mintShareJwt` from `routes/share.ts` — claims `{share:true, scope:'read'}`,
so the auth middleware enforces GET-only and accepts it via `?token=` on
`/api/stream` + `/api/cover`; `sub` = the poll creator, mirroring share links).
TTL is 30 min (`POLL_MEDIA_JWT_TTL_MS`); unlike `share/activate`'s one-shot
5-minute clock, the poll GET is **idempotent** — a poll link is multi-rater and
multi-visit, and the wizard silently re-fetches to refresh an expiring JWT (or
after a failed audio load, once).

## The public payload is deliberately lean

`publicPollView` strips features, scores, explanations and the engine's rank
from what raters see — leaking the engine's own confidence would bias the vote.
Candidates render in the frozen `displayOrder`, which currently equals `rank`
(the product intent is "emulate the queue the listener would get"); it is stored
as its own field so an anti-position-bias shuffle is a one-line generation-time
change. The export keeps true `rank`, so verdict-vs-rank makes position bias
measurable either way.

## Abuse posture

Self-hosted, token-is-credential — not a hardened public voting system. Guards:
rater key length bounds, note length cap, per-request batch cap (≤ the poll's
candidate count), and a distinct-rater cap per poll (`MAX_RATERS_PER_POLL`
1000, new raters 409 past it; existing raters can always update). Expiry is
optional (`expiresInHours`, capped at 90 days).

## Export & digestion

`bun run packages/api/src/scripts/export-radio-poll.ts [--poll <id|token>]
[--out <dir>]` — readonly DB open (prod-probe discipline), defaults to closed
polls. Emits one self-contained JSON per poll: settings, engine version,
weights, scenarios (seed/candidate features + score + rank + explanation) and
per-candidate tallies with a **consensus** (`consensusVerdict`: majority up =
`good`, majority down = `bad`, tie/zero = ungraded — an ambiguous grade is
worse than none). This dataset is the input for offline weight tuning: replay
`scoreSimilarity` under candidate weight sets (see `dump-radio.ts
--weights`) and score them by agreement with the human consensus.

**That replay ships as `scripts/eval-radio-poll.ts` (issue #583)** — per-poll +
pooled within-scenario pairwise AUC of the current `DEFAULT_WEIGHTS` (and a
`--weights` override side by side), grouped by `formula_version` so
cross-formula votes are never pooled. The pure half is
`services/radio-poll-eval.ts` (`evaluatePollAgreement`): axis values are
recomputed from the frozen features (so a formula change like the junk-genre
fix is measurable against old votes), except the embedding axis, whose vector
is stripped from snapshots — its frozen *value* is folded back in under the
candidate weight set. Off-policy caveat: a poll only graded the top-K its
generating formula served, so an AUC validates ordering among those
candidates, not pool selection (v2's sub-60 s pool floor is invisible to it).
The first calibration this loop produced is formula v2 — see docs/radio.md
"Calibration history".

**Station (vibe/filter) scenarios — shipped with formula v3.** `kind: 'filter'`
had been in the schema from the start with nothing generating it, and
`evaluatePollAgreement` skipped any seed-less scenario outright, so **every vote
collected up to v2 graded seed radio only** — the path that was not the reported
problem. A station poll now works end to end: `RadioPollSettings.filters` (an
array — one station per poll cannot answer "are my genre stations any good", and
the landing page alone offers eight chips) generates one `filterScenario` each
via `buildFilterRadio`, after the pinned seeds and ahead of the random auto
seeds; the snapshot freezes the `centroid` and the `filter` beside the
candidates, because a station has no seed song and without the centroid a replay
has nothing to score against; the export carries both; and the wizard renders a
**station card** (`poll-station-card`, `filterLabel` via `describeFilter`) where
the seed track's card would be — a seed-less scenario used to render nothing at
all above the candidate list, leaving raters grading an unexplained list of
songs. Admins name stations as comma-separated genres in the create form.

**Follow-ups deliberately not built yet**: fixture emission + a
`radio-eval.replay.test.ts` CI ratchet (the offline agreement harness above now
exists; freezing graded cases as committed fixtures is worth it once the vote
base is larger than 70), an OG link preview for `/poll/:token`, and A/B polls
with two weight sets interleaved.

## Web surfaces

- **Public wizard** `pages/poll/` — guard-less route above the app shell
  (like `/share/:token`). Intro → one step per scenario (fake Now Playing seed
  card, next-up rows with per-track 👍/👎 + preview play into one shared
  `<audio>`) → thanks. "Next" enables once every candidate has a verdict, and
  advancing POSTs that scenario's votes — partial sessions still contribute,
  and the upsert makes back-navigation safe. Pure step/vote logic lives in
  `poll-view.lib.ts`.
- **Admin card** `pages/admin/radio-polls/` — a `SettingsGroupComponent` on
  /admin (lazy `load()` on expand, like the generation-feedback queue): create
  form (name, counts, optional expiry, pinned seed songs via the shared
  `SongPickerComponent`, station genres as a comma-separated list; remaining
  slots use random genre-preferring auto seeds), list with
  copy-link/close/delete, and an expandable results view —
  per-candidate 👍/👎 tallies, approval bar, and the per-axis breakdown in the
  same `value×weight` string shape as dump-radio's `breakdownLine`.
