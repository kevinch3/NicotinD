# Storybook component catalog

A browsable, documented reference for the shared UI components in `@nicotind/web`, so a
contributor can pick the right component without reading its source and can see it in
every theme the app ships.

It is deliberately **not** a visual-regression system and **not** a developer-only
workbench. Both were considered; the catalog framing is what drives every decision below.
Visual regression is deferred to an issue and is cheap to add now that stories exist.

## Running it

```bash
bun run --filter @nicotind/web storybook       # dev server on :6006
bun run build:storybook                        # static build → packages/web/storybook-static
bun run smoke:storybook                        # render every story, fail on any that throws
```

Both build and smoke run in the CI `ci` job and in `bun run verify`.

## What is in it

36 components, split by how much of the app they need in order to render:

- **Presentational (19)** — zero injected services: `artist-links`, `changelog-modal`,
  `confirm-dialog`, `desktop-window-controls`, `disk-pill`, `download-item`,
  `genre-distribution-strip`, `genre-radar`, `icon`, `library-filter-panel`,
  `metric-pill`, `password-field`, `pipeline-stage-badge`, `seek-bar`, `selection-bar`,
  `settings-group`, `settings-group-header`, `source-chip`, `track-stats-bars`.
- **Light-DI (17)** — one to three injected services, rendered against fixtures:
  `add-to-playlist`, `artist-genre-modal`, `artist-identity-modal`, `artist-info`,
  `confirm-host`, `cover-art`, `desktop-title-bar-overlay`, `device-switcher`,
  `menu-panel`, `recently-played`, `song-picker`, `toast-outlet`, `track-context-menu`,
  `track-row`, `tv-shell`, `update-banner`, `welcome-banner`.

**Not in it (11):** `album-hunt-modal`, `artist-image-menu`, `bottom-nav`,
`feedback-detail-sheet`, `folder-browser`, `layout`, `metadata-fix-modal`, `now-playing`,
`player`, `review-inbox`, `track-info-sheet`. These inject 5–14 services (`layout` injects
14). They are compositions of the app, not shared primitives, and storying them means
reconstructing most of the service graph. See the deferred-work issues below.

## Adding a component

1. Put the story beside the component: `src/app/components/<name>/<name>.stories.ts`.
   Implementation, spec and story share one folder.
2. Set `tags: ['autodocs']`.
3. If the component injects services, add
   `decorators: [applicationConfig({ providers: storyProviders() })]`.
4. Give every state its own named story. A single `Default` documents nothing about the
   states a reviewer actually needs to see.

## Where the prose lives

**Per-component documentation is not written in MDX.** Compodoc extracts each
component's own class JSDoc into its autodocs page, so the description you read in
Storybook is the comment above the class — one source of truth that cannot drift. If a
component has no class JSDoc, add the description to its story meta:

```ts
parameters: { docs: { description: { component: '…' } } },
```

MDX is reserved for what has no component to attach to:

- `src/stories/foundations/` — Introduction, Theme, Icons, Layout.
- `src/stories/patterns/` — Song listing, Bounded modal.

## The support kit (`src/stories/support/`)

- `fixtures.ts` — one coherent fake library (one artist, one album, seven tracks) reused
  everywhere, so the catalog reads as a product rather than 36 unrelated placeholder
  strings. Everything satisfies the real interface; never `as any`.
- `http-fixtures.ts` — an `HttpInterceptorFn` answering `/api` from the fixtures.
  Unmatched routes return 404 rather than passing through, so a story can never reach a
  real network.
- `story-providers.ts` — `storyProviders(state?)`.

**There are no fake service classes, deliberately.** Every service the light-DI
components inject turned out to be a plain signal holder whose only outside dependency is
`HttpClient`. So stories run the *real* services and fake only the transport plus the
starting signal state. A fake class is a second implementation to keep in sync, and it
can stay green while the real service is broken — which would make the catalog fiction.

`storyProviders` also supplies two things every story needs:

- `provideRouter([], withDisabledInitialNavigation())`. The story URL is `/iframe.html`,
  which matches no route; with an empty route table every `RouterLink`-bearing component
  threw `NG04002` on mount.
- `provideServiceWorker(..., { enabled: false })` and `APP_VERSION`, which `UpdateService`
  injects.

## Toolbar globals

| Global | What it does | Why it matters |
| --- | --- | --- |
| Theme | writes `data-theme` on `<html>`, all seven presets | The presets had no surface where they could be compared |
| TV build | toggles `html.tv-build` | Overscan insets and D-pad focus rings were only observable on an Android TV emulator |
| Viewport | mobile / tablet / desktop | `menu-panel` flip, `selection-bar` and `settings-group` are responsive |

## Integration constraints

Three things about `@storybook/angular` that cost a build cycle each. Change them only
with a reason.

1. **`@angular-devkit/build-angular` is required, not optional.** The angular-cli preset
   reads
   `if (!resolvePackageDir('@angular-devkit/build-angular')) return baseConfig`, which
   looks like graceful degradation — but `resolvePackageDir` calls `require.resolve`
   *outside* its `try`/`catch`, so its absence throws. The documented fallback is dead
   code. It also means Storybook runs a webpack Angular toolchain beside this repo's
   esbuild `@angular/build`; `@storybook/angular` ships no Vite builder.

2. **Styles come from the `browserTarget`, not an import.** Once `build-angular` is
   installed, the preset reads `styles: ["src/styles.css"]` and the PostCSS handling from
   the `nicotind-web:build` target. Do not import `styles.css` in `preview.ts` —
   TypeScript cannot type a `.css` module — and do not add a `postcss.config.cjs` shim;
   the Angular pipeline already understands this repo's `postcss.config.json`.

3. **`.storybook/tsconfig.json` exists because the Angular webpack plugin rejects any
   file missing from the program**, and `tsconfig.app.json` reaches neither
   `.storybook/*.ts` nor the story files.

Two smaller ones:

- `webpackFinal` maps `.js` specifiers onto `.ts` (`resolve.extensionAlias`). `@nicotind/core`
  is TypeScript source using ESM-style `./licence.js` imports; esbuild resolves those
  natively, webpack does not.
- `ajv@^8` is a root devDependency. `ajv-keywords@5` peers `ajv@^8` and bun does not scope
  it, so it resolved to the hoisted root `ajv`, which was eslint's v6. Packages with a
  declared `ajv` dependency keep their own copy, so eslint still gets v6.
- Compodoc must be the `@compodoc/compodoc` package. `bunx compodoc` resolves an unrelated
  stale package whose CLI rejects the `-e` flag Storybook passes.

## Why there is a separate render gate

`build:storybook` compiles stories; it does not run them. The first green build of this
catalog shipped **67 of 139 stories that threw on mount** — the router and `SwUpdate`
problems above. Neither a type check nor webpack can see that class of failure. A catalog
that compiles but does not render is worse than no catalog, because it looks maintained.
`bun run smoke:storybook` renders every story and fails on any error.

## Publishing

`deploy.yml`'s `storybook-pages` job publishes the static build per release tag.

> **Manual prerequisite:** GitHub Pages must be enabled for the repository with source
> "GitHub Actions" (Settings → Pages). A workflow cannot enable it. Until it is set, that
> job fails — nothing depends on it, so a release is not blocked.

## Deferred work

Tracked under the `storybook` label.

| Issue | Work |
| --- | --- |
| [#470](https://github.com/kevinch3/NicotinD/issues/470) | Story the player / now-playing / layout shell trio |
| [#471](https://github.com/kevinch3/NicotinD/issues/471) | Story the acquisition modals (`album-hunt`, `metadata-fix`, `folder-browser`, `artist-image-menu`) |
| [#472](https://github.com/kevinch3/NicotinD/issues/472) | Story the review surfaces (`review-inbox`, `track-info-sheet`, `feedback-detail-sheet`, `bottom-nav`) |
| [#473](https://github.com/kevinch3/NicotinD/issues/473) | Visual regression on top of the stories |
| [#474](https://github.com/kevinch3/NicotinD/issues/474) | `@storybook/addon-a11y` plus triage of its findings |
| [#475](https://github.com/kevinch3/NicotinD/issues/475) | Interaction tests for `menu-panel`, `seek-bar`, `selection-bar` |
| [#476](https://github.com/kevinch3/NicotinD/issues/476) | i18n toolbar global (en/es) driving `TranslateService` |
| [#477](https://github.com/kevinch3/NicotinD/issues/477) | Catalog the shared directives and pipes |
| [#478](https://github.com/kevinch3/NicotinD/issues/478) | Migrate to a Vite builder when `@storybook/angular` ships one |
