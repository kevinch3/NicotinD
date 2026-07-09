# Source-Agnostic Acquisition (the north star)

NicotinD acquires music from several places — **Soulseek (slskd)**, **the
Internet Archive (archive.org)**, **Spotify** (metadata → spotDL), **yt-dlp**,
and more to come. The product principle is that **the source is an
implementation detail**: a user searches for music and gets one consolidated,
ranked list of acquirable results; they tap **Get** and the right backend runs.
No source is "the network" with the others bolted on as "Also on…" lanes.

This doc is the guideline every acquisition/search change must follow. It exists
because the app historically grew Soulseek-first (the unified search merged only
library + slskd; archive.org and Spotify were separate endpoints and separate UI
lanes; album hunt took a concrete `Slskd` client). That coupling is the thing we
are deliberately undoing.

## The five rules

1. **One candidate contract.** Every acquirable result, from any source, is an
   [`AcquisitionCandidate`](../packages/core/src/types/acquisition-candidate.ts)
   (`@nicotind/core`). Orchestrators and the UI depend on this shape, never on a
   concrete client. It carries a neutral `source`/`sourceLabel`, display fields,
   a `score` for cross-source ranking, and an **acquire intent**:
   - `{ via: 'url', url }` → handed to `POST /api/acquire` (archive.org item,
     Spotify→spotDL, yt-dlp, …).
   - `{ via: 'enqueue', sourceRef, files }` → the source's download capability
     (slskd: peer username + folder files).

2. **No primary source in the UI.** Search/hunt results render as **one blended,
   ranked list**. Sources are distinguished only by a neutral chip
   (`app-source-chip`: "Soulseek", "Internet Archive", "Spotify"). Forbidden
   framings: "the network", "search the network directly" as the headline,
   "From archive.org"/"From Spotify" as separate sections, "Also on …". Status
   copy is source-neutral ("Sources: …"), never "Soulseek network available".

3. **Sources are discovered/gated via the registry.** A source contributes
   nothing until its plugin is enabled (default-off compliance posture). Gating
   is `PluginRegistry`-driven (`isEnabled(id)` / `hasAnyAcquisitionEnabled()`),
   never a hardcoded `if (slskd)`. Adding a source is: implement the source
   adapter + a **pure mapper** to `AcquisitionCandidate`, register it at the
   composition root (`packages/api/src/index.ts`) — **zero route or UI changes**.

4. **One acquire dispatch.** A candidate carries its own acquire intent; the
   single Get action dispatches on `acquire.via`. The web mirrors this with
   [`lib/acquisition-candidate.ts`](../packages/web/src/app/lib/acquisition-candidate.ts)
   (`getBlended`/`getOtherSource` branch on `via`).

5. **Compliance is unchanged.** Acquisition is default-off; sources stay silent
   until an admin enables their plugin in Settings → Plugins. See
   [docs/plugins.md](plugins.md).

## How the pieces fit

| Concern | Source-agnostic seam | File |
| --- | --- | --- |
| Candidate contract + merge/rank | `AcquisitionCandidate`, `mergeCandidates`, `rankCandidates`, per-source mappers | `packages/core/src/types/acquisition-candidate.ts` |
| Blended **search** (synchronous metadata sources) | `CandidateSearchAggregator` over registry-gated `CandidateSource[]` → `GET /api/sources/search` | `packages/api/src/services/candidate-search.ts`, `routes/sources.ts` |
| Blended **album hunt** | `AlbumHuntOrchestrator` over `SourceHunter[]` (archive/Spotify) → `POST /api/discography/albums/:id/hunt/sources` | `packages/api/src/services/source-hunter.ts` |
| Acquisition gate | `requireAcquisitionMiddleware` → `hasAnyAcquisitionEnabled()` (any source, not only `download`) | `packages/api/src/services/plugins/gate.ts` |
| URL acquire (already agnostic) | `registry.getEnabledForUrl()` routes by `canHandle()` | `packages/api/src/services/acquire-watcher.ts` |
| Web blended list + chip | `mergeAndRank`, `BlendedCandidate`, `app-source-chip` | `packages/web/src/app/lib/acquisition-candidate.ts`, `components/source-chip/` |

### Soulseek is special, on purpose

Soulseek's search is **asynchronous** (a `searchId` the client polls) with live
peer/queue stats, and its album hunt is a **two-phase** flow that drives the
modal's progress animation. So Soulseek keeps its specialized search
(`/api/search` + `/{searchId}/network` poll) and two-phase hunt endpoints — but
its results are **mapped into the same blended list client-side**
(`songResultToCandidate`, the slskd folder candidates in the hunt modal). The
`CandidateSource`/`SourceHunter` abstractions cover the request/response metadata
sources (archive.org, Spotify, future). The user sees one list either way.

## Adding a new source (checklist)

1. Build the plugin (search/resolve/download capability) — see [docs/plugins.md](plugins.md).
2. Write a **pure** `xToAcquisitionCandidate` mapper (api side) and, if it shows
   in the web blended list, a `xToCandidate` in `lib/acquisition-candidate.ts`.
   Unit-test both.
3. Register a `CandidateSource` (search) and/or `SourceHunter` (album hunt)
   adapter at the composition root, gated by `plugins.isEnabled('<id>')`.
4. Add the source label to `SOURCE_LABELS` (core + web) and a chip tone in
   `app-source-chip`.
5. Do **not** add a new route or a new UI section. If you find yourself adding a
   "From <source>" lane, stop — it belongs in the blended list.

## Unified search

`GET /api/search?q=` queries the local library first (`LibrarySearchProvider`) and fires the slskd network search in parallel. Local results render above a divider, network/other-source results below.

- **Artist links resolve even for not-yet-local results.** Local song hits carry `artistId` (selected from `library_songs.artist_id`, threaded through `SearchProviderResult.songs` → `toTrack`) so a track played from search resolves the player's now-playing **"Go to artist"** link to the real artist page. **Network (slskd) hits have no `artistId`** (the artist isn't local yet), so the now-playing + downloads artist links resolve **by name** via `GET /api/library/artists/by-name?name=` (diacritic-insensitive lookup against `library_artists`; the pure `resolveArtistTarget()` in `lib/route-utils.ts`): known id → artist page, else a name that resolves to a local artist → their page, else `/library` (downloads falls back to a name search instead).
- **Network song hits are blended, not a separate lane.** `lib/song-results.ts` `groupBySong()` (dedupe + best-copy pick: FLAC > other lossless > highest-bitrate lossy, then peer availability) feeds `songResultToCandidate` and is merged into the **one source-agnostic Results list** (`data-testid="results"`, rows `acquire-result` + `source-chip`) alongside archive.org/Spotify candidates (from `GET /api/sources/search`), each with a single Get. The raw folder-tree browser stays under the demoted "Advanced" disclosure for whole-album peer grabs. The source-status line (`data-testid="source-status"`) is neutral ("Sources: …").
- **A pasted/shared link is a candidate too, not a second input.** The search omnibox recognizes a URL on submit (`parseLinkIntent`, `lib/link-intent.ts`) and renders one link-intent card (chip + Get, `data-testid="link-intent-card"`) in place of running a search — no separate "Get from a link" box or job list. Detection is gated behind `plugins.hasResolve()` so the affordance stays compliance-silent until a resolve-capable plugin is enabled (the PWA share-target is the one exception: sharing is an explicit intent, so it submits regardless and surfaces failure on the card). Get dispatches through the same `AcquireService.submit(url)` as every `via: 'url'` blended candidate; the card then tracks its own job by URL against `AcquireService.jobs()` — the Downloads feed remains the durable record.

## Known follow-ups

- **Unattended watchlist auto-download stays Soulseek-only** for now: it needs
  the album-completeness + cross-peer-fallback guarantees that metadata-only
  sources (archive.org/Spotify) can't offer. Multi-source auto-acquire is a
  deliberate future step, not an accident of the current design.
- **Fully slskd-free hunt mount**: the `/api/discography` group is still mounted
  alongside the slskd-coupled discography service; the source hunt + gate are
  already agnostic, but the mount condition is a follow-up.
