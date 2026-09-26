# Users, auth & access

One section of [the index](../index.md). Entry shape and caps are unchanged and
`bun run check:claude-md` still enforces them here.

- **Multi-user + roles**: shared library, per-user settings; ascending ladder
  `listener < user < refiner < admin` shared via core `roles.ts` (`canAcquire`/`canCurate`/`isAdmin`)
  with `requireAcquirer`/`requireCurator`/`requireAdmin` guards. → [roles.md](../roles.md)
- **Auth flow**: NicotinD issues its own JWTs (30-day sliding, silent refresh); share tokens are
  short-lived, read-only and non-refreshable. `authGuard` preserves the attempted URL and
  `sanitizeReturnUrl` validates it; an already-logged-in share link resolves in-app without burning
  the public token. → [design-patterns.md](../design-patterns.md), [web-ui.md](../web-ui.md)
- **Media key for cover URLs**: a stable per-user HMAC credential (`mediaKeyFor`/`verifyMediaKey`)
  replaces the rotating JWT in cover URLs so the browser cache survives refreshes; accepted only on
  media GETs (`MEDIA_PATH_RE`), web side `mediaToken()`. → [design-patterns.md](../design-patterns.md)
- **Public-signup kill-switch**: default-closed `registrationEnabled`; `RegistrationToggle` +
  `GET`/`PUT /api/admin/registration` back the Admin → User Management switch. Unlike acquisition,
  `NICOTIND_REGISTRATION` pins by *presence* (`resolveRegistrationEnabled`): set either way, the
  toggle is read-only. `registrationBlocked` exempts the first-user bootstrap.
  → [deployment.md](../deployment.md)
- **Device pairing (QR link) + remote access**: a 5-minute single-use token rendered as a QR link plus
  a printed fallback code; `parseApproveCode` and core `pairing-code.ts` `isPairingCodeShape` keep the
  minter and validator from drifting; `paired_devices` rows are revocable at refresh. Tailscale Funnel
  publishes the loopback backend. → [device-pairing.md](../device-pairing.md)
- **MCP agent access**: external agents curate via `/api/mcp` with a revocable `agent_tokens`
  bearer capped at refiner (`AGENT_EFFECTIVE_ROLE`); `checkToolAccess` gates scope + destructive
  confirm and `dispatchTool` audits writes. Shared mutation modules (`library-deletion.ts` …
  `album-cover-mutate.ts`) back HTTP and MCP alike. → [mcp-agent.md](../mcp-agent.md)
- **Curator origin + rare-genre tools**: `get_artist` returns origin *and* mbid (a wrong origin is
  usually an inherited wrong MBID); `set_artist_origin` writes the shared `mutateArtistOrigin`,
  `set_artist_mbid` fixes the cause behind it, and `get_rare_genres` (`rareGenres`) surfaces
  low-cardinality primary genres as mistag candidates. → [mcp-agent.md](../mcp-agent.md)
- **A missing MCP argument is an error, not empty data**: `missingRequiredArgs` rejects on each
  tool's own `inputSchema.required`, naming the keys sent; `htmlEntityArgs` refuses a literal HTML
  entity. → [mcp-agent.md](../mcp-agent.md)
- **`identify_song` — identity from the audio**: `identifySongById` is fpcalc + AcoustID and nothing
  else, batchable where `lookup_song_metadata`'s fan-out is not; typed outcome, suggests only,
  carries no genre. → [mcp-agent.md](../mcp-agent.md)
- **Presence tracking + last connection (admin-only)**: in-memory `PresenceService` from 60s
  heartbeats merged into `GET /api/admin/users` and ordered by `compareUsersByActivity`; the derived
  `last_seen_at` is persisted by `touchLastSeen` because an in-memory map reports "never" after every
  deploy. → [presence-tracking.md](../presence-tracking.md)
- **Curation review queue**: a durable "needs a human decision" flag a curator or MCP agent raises
  instead of guessing; `curation_flags`, `createCurationFlag`, `flag_for_review`, one open flag per
  target. → [mcp-agent.md](../mcp-agent.md)
- **Listener track reports**: listeners file into that same queue; `TRACK_REPORT_REASONS`,
  `recordListenerReport`, `curation_flag_reports` (the per-reporter rate limit), `isTasteOnly`.
  → [mcp-agent.md](../mcp-agent.md)
- **Curator triage rounds**: open review flags become typed decision cases served five per round from
  the library view, each option applying through an existing mutation service; `CurationCase`,
  `assembleRound`, `applyCaseEffect`, `CurateComponent`. → [curator-triage.md](../curator-triage.md)
- **Admin audit log**: `audit_log` + `recordAudit` called explicitly at destructive mutation sites,
  never as blanket middleware; entries carry `targetKind`/`targetId`/`detail`, and ledger failures
  never break the audited action. → [roles.md](../roles.md)
- **Onboarding**: setup wizard for self-hosters (music dir, quality, Lidarr) plus a first-login welcome
  banner for admin-provisioned users. → [onboarding.md](../onboarding.md)
- **Per-user preferences**: one typed object (`UserPreferences`, `parseUserPreferences`) that follows a person across
  devices — home view, theme, language, radio strategy, welcome — on `user_settings`, served by
  `getUserPreferences`/`patchUserPreferences` at `/api/me/preferences` and embedded in `/me`; the web
  door is `UserPreferencesService` (per-device mirror, optimistic `patch`). → [web-ui.md](../web-ui.md)
- **TV profiles**: several people on one TV, switched by `resetSession` + stored token;
  `TvProfileService`, `loadProfiles`, `rememberProfile`, `forgetProfile`; a cast from a stored
  person's phone switches the TV to them (`TvProfileListenerService`, `ProfileCastListener`).
  → [tv-ux.md](../tv-ux.md#profiles-1406)
