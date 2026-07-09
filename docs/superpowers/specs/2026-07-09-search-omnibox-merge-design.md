# Search omnibox — merge "Get from a link" into the search input

**Date:** 2026-07-09
**Status:** Approved design, pending implementation plan

## Problem

The Search view has two inputs with different purposes:

1. The top search bar (free text → catalog cards, library Songs, the blended
   source-agnostic Results list, the Advanced Soulseek disclosure).
2. A bottom "Get from a link" section (URL → `POST /api/acquire`), gated on
   `plugins.hasResolve()`, with its own inline acquire-job list.

Observed friction (user-selected):

- **Two inputs is confusing** — it isn't obvious which input serves which
  purpose; one entry point should infer intent (text = search, URL = acquire).
- **The inline acquire-job list is misplaced** — it duplicates the unified
  Downloads feed (which already adapts URL acquire jobs into `DownloadItem`s)
  and clutters the Search view.

## Decision summary

One omnibox. A pasted URL is treated as **one more acquisition candidate**: it
renders as a confirm card in the Results area (chip + Get), and after Get the
**card itself carries the job lifecycle** (progress → done/failed). The bottom
section and its job list are deleted; the Downloads feed remains the durable
record. Detection is **client-side and cosmetic** (Approach A) — the server's
`registry.getEnabledForUrl()` still picks the real backend at submit time.

Alternatives considered:

- **B — server-validated link preview** (`GET /api/acquire/preview?url=`
  running `getEnabledForUrl()` + metadata resolution before showing the card):
  more machinery + paste latency for confirmation polish; possible later
  enhancement on top of A.
- **C — full Search-page decomposition** into subcomponents while merging:
  right refactor eventually, but balloons the change beyond the selected
  frictions.

## Design

### 1. Intent detection (pure lib)

New pure module `packages/web/src/app/lib/link-intent.ts`:

- `parseLinkIntent(input: string): LinkIntent | null` — trims, requires a
  parseable `http(s)://` URL (`URL.canParse`, plus a bare-`www.` tolerance),
  returns `{ url, source, sourceLabel, host }` or `null` for ordinary text.
- Hostname → chip mapping: `youtube.com`/`youtu.be` → YouTube,
  `soundcloud.com` → SoundCloud, `bandcamp.com` (incl. subdomains) → Bandcamp,
  `spotify.com` → Spotify, `archive.org` → Internet Archive, anything else →
  "Link". Cosmetic only; no routing decisions are made client-side.

### 2. Omnibox behavior (`SearchComponent`)

- One input, placeholder **"Search music or paste a link…"**. The bottom
  `plugins.hasResolve()` section (heading, second input, job list) is deleted.
- On submit: `parseLinkIntent(query)` non-null → set a `linkIntent` signal and
  **skip all searches** (no catalog/Soulseek/archive/Spotify calls, and no
  Recent-searches history entry — history stays text-only). Null → the
  existing `executeSearch()` path, unchanged.
- The link card renders in the Results area styled like a blended row:
  `app-source-chip` + URL as title + a single **Get** button,
  `data-testid="link-intent-card"`.
- Clearing/replacing the input with text and searching clears `linkIntent`.

### 3. Get → the card becomes the job

- Get calls the existing `AcquireService.submit(url)` (the same dispatch the
  blended list uses for `via: 'url'` candidates).
- The card derives its state from `acquire.jobs()` (already polled), matched
  by URL:
  - `queued`/`running` → progress (`done/total` when present) + × Cancel
    (existing `cancelAcquireJob`).
  - `done` → "Added to library ✓".
  - `failed` → the job's error inline + a Retry that re-submits.
- No job list on Search; the unified Downloads feed is the durable record.

### 4. Edge rules

- **No resolve-capable plugin enabled:** the card still renders, Get disabled,
  hint: "Enable a download extension (yt-dlp / spotDL) to get links." (Today
  the whole capability is hidden by the `hasResolve()` gate; the card makes it
  discoverable instead.)
- **Spotify URL without spotDL:** Get opens the link in Spotify — same rule and
  amber hint as the blended list today.
- **PWA share-target (`?url=`/`?text=`):** still auto-submits (sharing is an
  explicit intent), but now also sets `linkIntent` so the user lands on the
  live card instead of the removed job list.
- A URL no enabled plugin can handle fails at submit; the failure surfaces as
  the card's `failed` state (server error message inline).

### 5. Testing (quality gates 1–2)

- `link-intent.spec.ts` (pure): plain text, URLs of each hostname family,
  `www.` forms, junk like a bare `http://`.
- `search.component.spec.ts` additions: URL submit renders the card and fires
  no search; text submit unchanged; Get → job-state transitions
  (running/done/failed); disabled-Get hint without a resolve plugin.
- Both run in CI via the existing `ng test` (vitest) workflow — no new
  workflow wiring needed, but verify the specs are picked up on push.
- e2e: adapt the existing acquire-URL flow in `packages/e2e` to the omnibox —
  `acquire-url-input` is removed; the flow drives `search-input` and asserts
  `link-intent-card` + its Get.

### 6. Documentation (quality gate 3)

- `docs/source-agnostic-acquisition.md`: pasting a link is one more candidate
  (chip + Get) in the blended list; job feedback lives on the card + Downloads.
- `docs/web-ui.md` / `docs/design-patterns.md`: Search-view entry updated.
- `CLAUDE.md`: one-line tweak to the URL-acquisition index bullet.
