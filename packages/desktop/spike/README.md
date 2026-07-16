# `bun build --compile` spike — outcome

Date: 2026-07-15 · Bun 1.3.14 (Linux x64)

## Question
Can the NicotinD backend ship as a single self-contained binary
(`bun build --compile`), or must the desktop app bundle the Bun runtime + source?

## Findings
- **Compile succeeds**: `bun build ./src/main.ts --compile` produces a ~99 MB binary in ~2s.
- **`import.meta.dir` → `/$bunfs/root`** inside the compiled binary, so
  `resolve(import.meta.dir, '../packages/web/dist')` (`src/main.ts:114`) points at a
  non-existent path. The compiled binary **requires** a `NICOTIND_WEB_DIST` override to
  serve the SPA. (This makes plan Task 3 **required**, not optional.)
- **Runtime failure: `Cannot find package 'pino-pretty'`.** The shared core logger
  (`packages/core/src/utils/logger.ts:5`) statically calls
  `require.resolve('pino-pretty')`. `bun --compile` links that target during binary
  startup, so the binary throws at launch **even in `NODE_ENV=production` and even after
  making the resolve lazy** — a runtime guard doesn't prevent bun from eagerly linking the
  static `require.resolve` target. Immediate exit, no stack trace.
  - Fully fixing Variant A would require a build-conditional logger that dead-code-eliminates
    the `pino-pretty` reference entirely for the compiled build — a real refactor, not a
    one-line guard.

## Verdict: **Variant B — Bun runtime + source**
Ship the `bun` binary + backend source + production `node_modules` inside the app and spawn
`bun run src/main.ts` (or `bun <entry>`). Rationale:
- Runs **identically to today** — no bundler externalization surprises, `pino-pretty`
  resolves from `node_modules`, `import.meta.dir` is correct.
- **No logger refactor** needed.
- Only marginal size cost: the standalone Bun binary is ~90 MB vs the 99 MB compiled binary —
  no meaningful single-binary size win to justify Variant A's bundling risk.

Do **not** use plain `bun build` (non-`--compile`) either — it performs the same static
bundling and would hit the identical `pino-pretty` externalization. Variant B ships
unbundled source.

### Consequences for the plan
- Task 3 (`NICOTIND_WEB_DIST` override) is **required**.
- Task 11 packaging uses **Variant B**: `prepare-resources.ts` stages a `bun` binary, the
  backend source (the `src/` entry + workspace `packages/{api,core,slskd-client,service-manager}`
  and their production `node_modules`), and `web/dist`; the sidecar spawns `bun run <entry>`.
