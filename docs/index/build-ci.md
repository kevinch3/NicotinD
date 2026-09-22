# Build, CI, deploy & ops

One section of [the index](../index.md). Entry shape and caps are unchanged and
`bun run check:claude-md` still enforces them here.

- **Cache directives for the static build**: `cacheControlForStatic` splits content-hashed output
  (`immutable`) from everything whose name outlives its bytes (`no-cache`), because Hono's
  `serveStatic` sends no freshness at all and a heuristically-cached `index.html`/`ngsw.json` strands
  an installed PWA on an old build. → [web-ui.md](../web-ui.md)
- **Quality gates assert their own denominator**: a gate that computes a smaller candidate set than it
  should still exits 0 truthfully. Gates derive their denominator independently, print what they
  examined, fail on what they cannot classify, and check allowlists both ways.
  → [quality-gates.md](../quality-gates.md)
- **`check:route-auth`**: fails when an `/api` group is mounted without `auth` or a reasoned
  `PUBLIC_ROUTES` entry; AST-parsed, not grepped, and it fails when its own count disagrees with the
  file's. → [api-routes.md](../api-routes.md)
- **One APK per form factor, F-Droid included**: no build flavour — the single build is
  policy-clean and hides its self-updater at runtime via `getInstallerPackage` +
  `isStoreManagedInstaller`; `androidAppId` gives TV its own id. → [fdroid.md](../fdroid.md)
- **Own signed F-Droid repository**: `build-fdroid-repo.ts` + `FDROID_APPS` assemble and sign it
  from the release's APKs; `pages.yml` publishes it beside the Storybook catalog.
  → [fdroid.md](../fdroid.md)
- **Reproducible Android build**: F-Droid rebuilds the APK and compares byte-for-byte;
  `pinManifestTimestamp` (web `postbuild`) fixes the one nondeterministic input, `dependenciesInfo`
  is off, and `apk-diff.ts` names a differing entry. → [fdroid.md](../fdroid.md)
- **fdroiddata build recipe, kept in-repo**: `packages/mobile/fdroiddata/*.yml` is what a
  `fdroiddata` MR carries; `check:fdroid` pins its bun version to `BUN_VERSION` and its
  `cap sync` step. `nicotindVersion` in `build.gradle` versions a bare checkout.
  → [fdroid.md](../fdroid.md)
- **`check:audit` — gated on what *ships***: filters advisories by the production closure (walking
  `bun.lock` from every workspace's `dependencies`) *and* the resolved version, reports the dependency
  path, fails on an unresolvable version, and warns-and-passes on an unreachable registry.
  → [quality-gates.md](../quality-gates.md)
- **`check:install-scripts`**: no dependency runs an unreviewed install hook, keyed on its command
  text and walked from the workspace roots. `scan`, `unreviewed`, `staleEntries`.
  → [quality-gates.md](../quality-gates.md)
- **`check:library-queries`**: plans every library list route through the real filter builders across
  every filter dimension and fails a `library_songs` scan that is not evaluated once; routes and
  dimensions are both discovered, so an unmodeled one fails. `judgeSongScans`,
  `discoverListRoutes`. → [library-filters.md](../library-filters.md)
- **`check:fetch-timeouts`**: every outbound call is bounded. The gate walks the AST and matches any
  callee that *tokenises* to fetch, catching injected clients a `\bfetch\b` regex misses; signals go
  inline, after any throttle, since a timeout starts counting when constructed.
  → [quality-gates.md](../quality-gates.md)
- **External reachability probe**: `kpc-probe.sh` runs on the edge droplet, not the host — a host
  that is up and unreachable reports perfect health from inside. Its `decide` state machine debounces,
  de-storms and checks a control host before blaming the target. Swap and memory alarms are measured
  useless here; load discriminates. → [host-monitoring.md](../host-monitoring.md)
- **Container memory limits**: every compose service declares `mem_limit` and `memswap_limit`, set
  equal so no container may swap, enforced by `compose-memory-limits.test.ts` against a whole-stack
  budget. → [deployment.md](../deployment.md)
- **Secret + image scanning**: gitleaks runs over every commit as a pinned binary, needing
  `fetch-depth: 0`; Trivy scans the published image scoped to OS vulns and unfixed-ignored, as a
  *step* so blocking the deploy needs no `if:` edit. → [quality-gates.md](../quality-gates.md)
- **CI boots the shipped artifact**: the docker build is unconditional and loaded, then a smoke step
  waits on the image's own healthcheck and asserts `/api/health` reports the expected version,
  matrixed over both published arches on native runners, never QEMU. The deploy then polls the host
  for that version. → [quality-gates.md](../quality-gates.md)
- **Published Docker image**: multi-arch GHCR image published per release tag via native-runner digest
  builds and one manifest merge. The deploy *derives* which images to pull from the resolved compose
  config rather than a hardcoded list. Release tagging is orphan-tag-proof.
  → [deployment.md](../deployment.md)
- **The runtime image ships only what it runs**: the production stage installs with `--production`
  from the isolated store, `.dockerignore` excludes tests, and `USER bun` needs `/data` chowned.
  → [deployment.md](../deployment.md)
- **Unsafe shipped defaults, announced before removal**: `findInsecureDefaults`
  (`services/insecure-defaults.ts`) warns at boot, after the ready handshake, never fatally — it checks
  registered addon tokens, not env vars. → [deployment.md](../deployment.md)
- **Bounded outbound clients**: `LidarrClient` timeouts come in three tiers (local, lookup,
  provision); a timeout is re-thrown as "timed out". MusicBrainz uses a discriminated `FetchOutcome`
  so an outage is never cached as a confirmed absence. → [design-patterns.md](../design-patterns.md)
- **We build the YouTube PO-token provider**: `ghcr.io/kevinch3/nicotind-pot-provider` built from
  pinned upstream source; the canonical version is published on the artifact as a label, pinned by
  `pot-provider-pin.test.ts`. → [deployment.md](../deployment.md)
- **Service modes**: `embedded` (best-effort manage Lidarr) or `external`; the library and streaming
  stack is always in-process. → [design-patterns.md](../design-patterns.md)
- **Observability (Sentry, opt-in)**: empty DSN = off; the web SDK loads lazily behind a synchronous
  `error-buffer.ts` + `BufferingErrorHandler` that replays startup errors on connect; the API reports
  only unknown 500s plus aggregated `captureProcessingFailure` events.
  → [observability.md](../observability.md)
- **Metadata-provider health**: `recordProviderCall` at the two client seams feeds a bounded
  15-minute ring (`providerHealthSnapshot`, `PROVIDER_HEALTH_WINDOW_MS`) surfaced as ServiceReview's
  `providers` slice; a MusicBrainz 404 counts as ok, because it is the provider answering.
  → [observability.md](../observability.md)
- **Server update check + version history**: daily cached GitHub-releases poll, marker-guarded and
  scheduled from `main.ts` (never the processor tick, so unit tests cannot hit the network);
  `version_history` records every version booted. → [deployment.md](../deployment.md)
- **Dependency management**: `bun outdated --filter '*'` drives manual bumps and CI is the gate; two
  majors are deliberately held by peer constraints. Renovate is configured with majors isolated,
  automerge off, and an unscheduled `vulnerabilityAlerts` block.
  → [dependency-management.md](../dependency-management.md)
- **OSS best-practices roadmap**: prioritized adoption plan of Immich/Home-Assistant practices.
  → [oss-best-practices.md](../oss-best-practices.md)
