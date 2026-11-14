# Licensing and the in-app About surface

NicotinD is distributed under **AGPL-3.0-only** (`LICENSE`, and the `license` field in the root
`package.json`). The AGPL adds §13 to the GPL: a user who interacts with the program *over a
network* is entitled to the complete corresponding source of the version they are using. A
self-hosted streaming server is exactly that case, so shipping the licence text in the repository
is not enough — the running app has to make the offer where the network user can see it.

`/settings/about` is that surface (issue #453).

## What the About page states

One `<app-settings-group>` card (`AboutComponent`, `pages/settings/about/`), collapsed by default
like every other settings card:

- the app name and the version, from `inject(APP_VERSION)`;
- the **build**, from `inject(APP_BUILD_INFO)` — see below;
- the AGPL-3.0-only statement plus the warranty disclaimer, and a link to the canonical licence
  text (`LICENCE_URL`);
- the **§13 offer**: a link to the corresponding source. When the build is stamped, the link is
  pinned to that exact tree (`<repo>/tree/<sha>`) and the repository root is offered beside it;
  unstamped, the repository root *is* the offer. `resolveBuildInfo` guarantees the link always
  resolves, because an offer that 404s is not an offer;
- a **Release notes** button that opens the shared `ChangelogModalComponent` — the same component
  the shell and the Settings page mount, not a second copy of the modal;
- a **third-party notices** section: a count and a toggle that lists every component in
  `packages/web/public/licenses.json`, each name linking to its source and each single SPDX id to
  its text on spdx.org (`spdxUrl`; an expression such as `(MIT OR Apache-2.0)` stays unlinked). The
  JSON is imported, not fetched, so the list is the one this bundle was built with and reads
  offline. See "The third-party manifest" below.

Every string is in both `packages/web/public/i18n/en.json` and `es.json`; `about.component.spec.ts`
asserts that parity for the page's whole key set, because a missing `es` key degrades a compliance
notice to a raw dotted key.

Adding the route also means registering it in `packages/e2e/tests/settings-consistency.spec.ts` —
in **both** its `ROUTES` array and its `WRAPPER_MAX_WIDTH` map. A settings route absent from those
is not asserted against the family's card-style, collapsed-by-default and gutter conventions, and
the suite still passes: the family assertions silently skip it.

## How the build identity is threaded

`lib/build-info.ts` resolves `BUILD_INFO` once, at module load, and `app.config.ts` provides it as
`APP_BUILD_INFO`. The value is fixed **when the bundle is built** — it is never fetched from the
API at runtime, so the page states the identity of the code the user is actually running rather
than of whatever the server happens to answer.

It is threaded differently from the version, though, and deliberately. The version comes from the
tracked root `package.json`; a commit sha cannot, because a value derived from `HEAD` is stale the
moment it is committed, and regenerating it on every build is the accidental-commit churn that
`packages/web/public/changelog.json` already causes. So the bundler substitutes it instead:

```
ng build --define NICOTIND_BUILD_COMMIT="<sha>"
```

`build-info.ts` declares that identifier ambient and reads it behind a `typeof` guard, so a build
that passes no `--define` leaves it an unbound free variable rather than throwing. The `Dockerfile`
web-builder stage takes the sha as a build arg and passes the flag (`printf` supplies the JSON
quotes esbuild requires, avoiding backslashes the Dockerfile parser would also claim), and
`deploy.yml` passes `NICOTIND_BUILD_COMMIT=${{ github.sha }}`. Anything else — a local `ng build`,
a Storybook build, the e2e bundle — resolves to "unstamped", which is honest: those bundles have no
published tree to point at.

`resolveBuildInfo` validates the sha rather than trusting it, because an unpassed `--define`
arrives as the empty string and a mis-wired one arrives as whatever the shell left behind.

## Surfaces this does not cover

The TV build is a **route-level fork** (`isTvBuild()`, docs/tv-ux.md): its `settings` route is
`TvSettingsComponent`, and the settings sub-pages are deliberately absent, so `/settings/about` does
not render there. That is not a §13 gap — §13 binds whoever *operates* the server, and the server's
own web UI carries the offer — but a distributed APK is covered by §§4–6 instead (source alongside
the object code), which the GitHub release does not currently state anywhere in-app. If the TV or
mobile shells ever need their own notice, it wants a 10-foot layout rather than this card: external
links are not reachable from a D-pad WebView.

## The third-party manifest

`scripts/generate-licenses.ts` writes `packages/web/public/licenses.json` (#453). The owner decided
three things on 2026-11-09: **SPDX ids plus links**, not bundled licence texts; generated **at
release only**; and the acquisition addons' images are out of scope, since they are separate repos
with their own trees.

- **What it walks:** the production closure (`dependencies` and installed `optionalDependencies`,
  never dev) of every workspace that ships, in `SHIPPING_ROOTS`: the root (the server), `web` and
  `mobile`. Resolution is Node's, from each package's real directory, so bun's isolated store
  resolves a dependency as the sibling it is. `@nicotind/*` packages are walked through but not
  listed, because they are this repository. A missing required dependency **throws**: a manifest
  that drops a package states something false. An optional one that is not installed (another
  platform's binary) is skipped, so the list matches the Linux image the release builds.
- **What npm cannot see** is curated in `NON_NPM`: Bun, the image's FFmpeg, Chromaprint (`fpcalc`)
  and opus-tools, and the analysis sidecar's Python stack. A new apt package or Python dependency
  needs an entry there.
- **When it runs:** `.versionrc.json`'s `postchangelog`, so the release commit carries it. No build
  or test rewrites it, unlike `changelog.json`. There is deliberately no CI freshness gate: a gate
  that a release-only step satisfies would be red on master between releases.
- **What is gated:** `scripts/generate-licenses.test.ts` reads the committed file and fails on a
  package with no declared licence, or one whose licence an AGPL-3.0-only program cannot ship
  (`COMPATIBLE`). An exception needs an entry in `UNDECIDED` naming the issue that decides it;
  there are none today.
- **What is not walked:** `BUILD_TOOLING`, the packages `scripts/prune-build-tooling.ts` deletes from
  the production install (below), and anything only they pulled in. Sentry's CLI is not listed
  because it does not ship.

`ng build` also emits `packages/web/dist/3rdpartylicenses.txt`, the full texts of what the browser
bundle contains. It is neither served nor linked; the manifest is the in-app list.

## Build tooling kept out of what ships

`@sentry/node` lists `@sentry/bundler-plugins` as a regular dependency, and that pulls in Sentry's
CLI, `sentry`, licensed **FSL-1.1-Apache-2.0**: source-available, not open source, so not something
an AGPL-3.0-only release should distribute (#1810, owner ruling: keep it out). Only `@sentry/node`'s
`bundler-plugin/*` subpaths import the plugins, and nothing at runtime does.

`scripts/prune-build-tooling.ts` deletes both packages after each production install: in the
Dockerfile's production stage and in the desktop backend staging (`prepare-resources.ts`). It
handles bun's isolated store and the hoisted layout, and exits non-zero when it finds neither
package, so a Sentry upgrade that drops the dependency surfaces as a build failure to revisit rather
than a silent no-op. The Dockerfile then imports `@sentry/bun`, so an upgrade that starts needing
the plugins at runtime fails the image build instead of reaching a host.
