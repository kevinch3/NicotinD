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
- a third-party notices section that **declares the gap** rather than rendering empty. An empty
  section reads as "there are none", which would be a false statement about a bundle that ships
  Angular, RxJS and ffmpeg.

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

## Not shipped yet: the generated third-party manifest

Issue #453 also asks for a generated manifest of bundled third-party components and their licences,
a `check:licenses` gate over it, and coverage of the non-npm tail (`packages/analysis`'s Python
dependencies, the bundled ffmpeg, the vendored PO-token provider). None of that is built. It is
blocked on three owner decisions that must not be guessed:

1. **Full licence texts bundled, or SPDX ids plus links?** Bundling is the safer reading of the
   GPL-family notice requirements and costs bundle size; linking is smaller and assumes the user
   has network access to a third party.
2. **Generated on release only, or on every build?** Recommendation: release only. The precedent —
   `scripts/build-changelog.ts`, wired into both `prebuild` and `pretest` — regenerates a tracked
   file on every build and test run and is a recurring source of accidental commits. A manifest
   generator belongs in `bun run release`.
3. **Are the acquisition addons' images in scope?** They are separate repos and images with their
   own dependency trees, and yt-dlp/spotdl moved out of the core image.

Until that lands, the dependency manifests in the linked source are the authoritative list, which
is what `about.noticesPending` says.

One head start for whoever picks this up: `ng build` already emits
`packages/web/dist/3rdpartylicenses.txt` — the licence texts of everything bundled into the web
bundle. It is neither served nor linked today, and it covers only the browser bundle (not the API's
dependencies, the Python analysis sidecar, or ffmpeg), so it answers part of decision 1 and none of
decision 3.
