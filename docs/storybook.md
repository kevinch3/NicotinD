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
bun run gates:storybook                        # render smoke + axe in one pass (what CI runs)
```

All of it runs in the CI **`storybook`** job and in `bun run verify`. It used to live in
the `ci` job; that job had become the workflow's entire critical path, and these gates
were the slowest half of it — see [deployment.md](deployment.md) "CI coverage".

## What is in it

37 components, split by how much of the app they need in order to render:

- **Presentational (20)** — zero injected services: `artist-links`, `changelog-modal`,
  `confirm-dialog`, `desktop-window-controls`, `disk-pill`, `download-item`,
  `genre-distribution-strip`, `genre-radar`, `icon`, `library-filter-panel`,
  `metric-pill`, `password-field`, `pipeline-stage-badge`, `seek-bar`, `selection-bar`,
  `settings-group`, `settings-group-header`, `skeleton`, `source-chip`, `track-stats-bars`.
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
| Language | `en` / `es`, applied to `TranslateService` | Spanish runs 20-30% longer than English, so a translation that overflows its container was invisible until it shipped |

**How the Language global reaches the render.** The decorator can't set the language
directly: `TranslateService` is `providedIn: 'root'`, so every story gets its own instance
inside its own Angular application and a decorator has no handle on it. So `withLang`
records the choice in `story-lang.ts` and `storyProviders()`'s app initializer applies it —
the same shape as `withTvBuild`, which also reaches the render through shared state. The
initializer **returns** the load promise, so Angular waits for it; otherwise the first
paint renders raw keys.

The catalogs are the **real** `public/i18n/*.json`, already served through `staticDirs` —
not a stub with invented strings, which would leave the story testing copy that doesn't
ship.

**Verified, not assumed.** The `t` pipe is `pure: false`; a pure pipe memoizes on its
arguments, so it would never re-run on a language change and the panel would silently keep
showing English. Confirmed by rendering `iframe.html?globals=lang:en` vs `lang:es` and
diffing the text — they differ, and the Spanish side is real copy rather than raw keys.
`Foundations/Internationalization` is the story that shows it: the eight highest-growth
strings (measured against the shipped bundles, not picked by eye) in a 320px column, the
narrowest real container in the app. Note that only one *component* story currently uses
the `t` pipe (`recently-played`) — most translated copy lives in the app-shell components
that are deliberately out of catalog scope, so this Foundations page is where the global
is actually exercised.

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

## Accessibility audit

`@storybook/addon-a11y` runs axe per story in the Storybook UI — the right surface while
fixing one component. The whole-catalog view is a script:

```bash
bun run a11y:storybook              # report, always exits 0
bun run a11y:storybook -- --strict  # exit 1 on any violation
```

`a11y:storybook:strict` **is a CI gate**, in the `storybook` job and in `bun run verify`.
It shipped as a report first and was promoted only once it reached zero violations: a gate
that starts red gets disabled rather than fixed.

## One traversal, not two (`storybook-gates.mjs`)

Smoke and axe were two scripts, and about half of each was byte-identical — the same
static server, the same `index.json` enumeration, the same `iframe.html` URL. The cost was
not the duplication but the **second full traversal**: two browsers, 138 navigations each,
114s + 159s of CI to ask two questions about the same page.

They are now one script over one traversal, with the shared plumbing in
`packages/e2e/scripts/lib/storybook-runner.mjs` (registered in `check:shared-helpers`, so
a third copy fails the build). Flags select the checks — `--smoke`, `--a11y`, `--strict` —
and the exit contributions stay independent: smoke always gates, axe only under
`--strict`. Running both no longer lets a smoke failure hide the axe report, which the old
`smoke && a11y` shell chain did.

Two things make it fast, both measured against the old scripts on the same build:

- **A pool of contexts.** `visitStories` drives `min(4, availableParallelism())` context+
  page pairs over a shared work queue. `STORYBOOK_GATE_CONCURRENCY=1` restores serial
  order when debugging. Completion order is no longer stable, so every report collection
  is sorted before printing.
- **Waiting on first render, not `networkidle`.** The old `waitUntil: 'networkidle'` cost a
  hard ~500ms quiet window per story, twice. It is now `waitUntil: 'load'` (still enough
  for stylesheets, which axe's contrast rules need) plus a wait for `#storybook-root` to
  have content — the exact condition the smoke check asserts on — or for Storybook's error
  box to become visible, so a broken story reports immediately instead of timing out.

**Measured: 273s → 61s, with identical output.** Verified both directions on the same
build: clean catalog reports 138 stories / 0 failing / 0 axe rules under old and new
alike; and with a deliberately broken component plus a deliberate contrast regression,
both report the **same 7 story ids and the same 16 nodes across the same 2 components**.
Detection is not weaker for being faster.

### The one thing the faster wait broke, and why it is handled here

`@storybook/addon-a11y` is configured in `.storybook/main.ts`, so a story iframe runs axe
**by itself** on mount. `networkidle` hid that by accident — its quiet window outlasted the
addon's scan. Reaching the page sooner means `AxeBuilder` can start while the addon still
holds the page's single axe instance, and axe throws "Axe is already running"; nine stories
hit it on the first merged run. `analyzeWithRetry` retries that specific error and nothing
else. Do not "fix" it by going back to `networkidle` — that only makes the race rarer.

### What the audit found, and what it changed

The first run reported three rules over 139 stories. All three are now clean, so
`a11y:storybook:strict` is a **CI gate** — it was promoted only after reaching zero,
because a gate that starts red gets disabled rather than fixed.

| Rule | Impact | Outcome |
| --- | --- | --- |
| `button-name` | critical | Fixed — nine icon-only buttons had no accessible name |
| `color-contrast` | serious | Fixed — 241 nodes → 0 ([#481](https://github.com/kevinch3/NicotinD/issues/481)) |
| `link-in-text-block` | serious | Fixed — changelog commit links now underlined ([#482](https://github.com/kevinch3/NicotinD/issues/482)) |

### Keeping it at zero: the skeleton's contract

`SkeletonComponent` was the first component added after the gate went green, and it
is the shape most likely to break it — a decorative `aria-hidden` subtree that also
has to announce when it *is* the page's loading state. It holds at zero because the
subtree is **textless**: the accessible name comes from `aria-label` on the host, not
an `.sr-only` string, since a clipped text node is exactly what axe reports as a
`color-contrast` *incomplete*. `role="status"` and `aria-hidden` are mutually
exclusive by construction (`skeletonAria`), and no variant renders anything focusable,
so `aria-hidden-focus` cannot fire. Both branches have their own story
(`LabelledAndDecorative`) so the gate exercises each. Full rationale in
[web-ui.md](web-ui.md) "List loading skeletons".

**`button-name` was a real app defect**, not a story artifact: the transport controls in
`player-transport-mini`, `now-playing-transport` and the karaoke overlay, plus Now Playing
close, album-hunt close and the settings-group toggle, announced nothing to a screen
reader. Counting them needs care — `title` also supplies an accessible name, in any
binding form, so a pass looking only for `aria-label` over-reports by roughly 2×.

### The contrast work, in the order the measurements forced

Going from 241 failing nodes to 0 took four distinct fixes, and the first one was a bug in
this catalog rather than in the app:

1. **The story canvas was unthemed** (~70 nodes). Storybook's canvas is white and the
   app's background lives on the layout shell (`bg-theme-base`), which no story renders —
   so dark-theme text sat on white. `withThemedCanvas` in `preview.ts` paints the canvas
   from `--theme-bg`. Without this fix the remaining measurements would have been taken
   against a background the app never shows.
2. **`--theme-text-muted` was the single biggest cause** (185 nodes), failing at
   3.08–4.11 across surfaces. Raised per theme against each theme's *lightest* surface,
   preserving hue and staying visibly dimmer than `--theme-text-secondary`. `eink` already
   passed at 9.57.
3. **Accent needed splitting into two tokens.** Accent-as-text and white-on-accent-fill
   pull the requirement in opposite directions — one value cannot satisfy both (accent
   text measured 2.37:1 on warm-paper's surface-2, while white on that same accent needs
   the fill to stay dark). `--theme-accent-text` is now the text one, registered as
   `text-theme-accent-text`; `--theme-accent` stays the fill. `WelcomeBanner` also
   hardcoded `color: #fff` instead of `--theme-on-accent`, which was simply wrong on
   warm-paper, where on-accent is a dark brown.
4. **Disabled rows are exempt, not broken.** WCAG 1.4.3 exempts text in an inactive
   component, but axe applies that only to native `:disabled` controls — a disabled
   `TrackRow` is a `<div>` with `opacity-40 pointer-events-none`, so its dimmed text read
   as five failures. Lightening it would defeat the disabled affordance. The row now
   carries `aria-disabled` (which it should have had regardless — a screen reader could
   not tell it was unavailable) and the audit excludes `[aria-disabled="true"]`.

Per-theme failing nodes before the fixes, which is what showed contrast to be a
theme-token problem rather than a component one:

| Theme | Before | After |
| --- | --- | --- |
| `midnight` (default) | 98 | 0 |
| `oled` | 95 | 0 |
| `daylight` | 6 | 0 |
| `eink` | 0 | 0 |

## Publishing

`.github/workflows/storybook-pages.yml` publishes the static build **on every push to
master** that touches `packages/web/**` or `packages/core/**`.

Not per release tag, which is what this shipped as first. The catalog documents the
components as they exist now; a developer reads it to decide whether to use a component
today, so publishing from a tag left it lagging to the last release — stale docs, which
this repo treats as a bug. Publishing from master also sidesteps the `github-pages`
environment's default deployment policy, which permits the `master` branch only and
rejected the tag-triggered deployment outright (`Tag "v0.1.339" is not allowed to deploy
to github-pages`).

Deployments queue rather than cancel (`cancel-in-progress: false`): a cancelled run would
leave the published catalog behind the master it claims to document.

> **Manual prerequisite:** GitHub Pages must be enabled for the repository with source
> "GitHub Actions" (Settings → Pages). A workflow cannot enable it. Until it is set, the
> workflow fails — nothing depends on it, so nothing else is blocked.

## Deferred work

Tracked under the `storybook` label.

| Issue | Work |
| --- | --- |
| [#470](https://github.com/kevinch3/NicotinD/issues/470) | Story the player / now-playing / layout shell trio |
| [#471](https://github.com/kevinch3/NicotinD/issues/471) | Story the acquisition modals (`album-hunt`, `metadata-fix`, `folder-browser`, `artist-image-menu`) |
| [#472](https://github.com/kevinch3/NicotinD/issues/472) | Story the review surfaces (`review-inbox`, `track-info-sheet`, `feedback-detail-sheet`, `bottom-nav`) |
| [#473](https://github.com/kevinch3/NicotinD/issues/473) | Visual regression on top of the stories |
| ~~[#474](https://github.com/kevinch3/NicotinD/issues/474)~~ | ✅ `@storybook/addon-a11y` plus triage — findings became [#481](https://github.com/kevinch3/NicotinD/issues/481) / [#482](https://github.com/kevinch3/NicotinD/issues/482) |
| [#475](https://github.com/kevinch3/NicotinD/issues/475) | Interaction tests for `menu-panel`, `seek-bar`, `selection-bar` |
| ~~[#476](https://github.com/kevinch3/NicotinD/issues/476)~~ | ✅ i18n toolbar global (en/es) driving `TranslateService` |
| [#477](https://github.com/kevinch3/NicotinD/issues/477) | Catalog the shared directives and pipes |
| [#478](https://github.com/kevinch3/NicotinD/issues/478) | Migrate to a Vite builder when `@storybook/angular` ships one |
