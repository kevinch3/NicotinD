/**
 * Fail when a workflow pins a GitHub Action old enough to run on a retired
 * Node runtime.
 *
 *   bun run check:action-runtimes
 *
 * WHY: every action that ships a JavaScript runtime declares it in its own
 * `action.yml` as `runs.using: node20` / `node24`. GitHub retires those
 * runtimes on its own schedule, and the retirement is announced as a **warning
 * in the run log** — a channel nothing in this repo reads. Issue #848 found 14
 * of 17 pinned actions still on `node20` across 67 call sites, several of them
 * two to four majors behind, discovered only because a human happened to scroll
 * a deploy log.
 *
 * The warning is also the *gentle* phase: the runner force-upgrades the action
 * to a newer Node until the fallback is removed, and then the step simply stops
 * working. For the actions in `deploy.yml` that means the failure lands in the
 * release lane, after the tag is cut.
 *
 * The deeper cause was that nothing bumps GitHub Actions here at all —
 * `renovate.json` was written but never enabled, so the `github-actions`
 * manager had no updater behind it. Enabling Renovate fixes the *drift*; it
 * does not make the drift **fail**, and an unenforced convention in this repo
 * is how `renovate.json` itself sat inert. This gate is the assertion.
 *
 * NETWORK-FREE ON PURPOSE. Resolving `runs.using` live would mean an outbound
 * call per action inside `verify` — offline-hostile, rate-limited, and a gate
 * that cannot run is a gate that stops being run. Instead {@link RUNTIME_FLOORS}
 * records the minimum major known to carry a current runtime, which is a fact
 * that only changes when someone deliberately bumps an action.
 *
 * It asserts its own denominator (docs/quality-gates.md): a floor table that
 * quietly covers fewer actions than the workflows use would still exit 0
 * truthfully. So this fails three ways, not one — a pin below its floor, an
 * action with **no** floor entry, and a floor entry **no workflow uses**. The
 * last one matters because dead config is how a stale rule survives a rename
 * while looking like it is still doing work.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { Glob } from 'bun';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Files that can carry a `uses:` — workflows plus this repo's composite actions. */
export const WORKFLOW_GLOBS = ['.github/workflows/*.yml', '.github/actions/*/action.yml'] as const;

/**
 * What a floor entry asserts about one action.
 *
 * `minMajor` is the lowest major whose `action.yml` declares a **current** Node
 * runtime — not the newest release. Pinning the newest would turn every
 * upstream major into a red gate, which is Renovate's job to propose and a
 * human's to review, not this gate's to force.
 *
 * `composite: true` means the action declares `runs.using: composite` and has
 * no Node runtime of its own. Recorded explicitly rather than skipped, so a
 * composite action is *classified* — an action this gate cannot see is the one
 * thing it must never pass silently.
 */
export interface RuntimeFloor {
  minMajor?: number;
  composite?: boolean;
  /** Why this floor, in the form a reader needs when the gate fires. */
  note: string;
}

/**
 * Every action these workflows use, and the floor it must clear.
 *
 * Adding an action to a workflow without adding it here is a deliberate
 * failure: the gate cannot classify a runtime it has never been told about,
 * and guessing would defeat the point.
 */
export const RUNTIME_FLOORS: Record<string, RuntimeFloor> = {
  'actions/checkout': { minMajor: 5, note: 'v4 is node20; v5 is the first node24 major' },
  'actions/cache': {
    minMajor: 5,
    note: 'v4 is node20. v5+ also crosses the cache-service v2 migration — a miss degrades to a slow build, it does not fail, so verify cache HITS in the log after a bump',
  },
  'actions/setup-node': { minMajor: 5, note: 'v4 is node20; v5 is the first node24 major' },
  'actions/setup-java': { minMajor: 5, note: 'v4 is node20' },
  'actions/setup-python': { minMajor: 6, note: 'v5 is node20' },
  'actions/upload-artifact': {
    minMajor: 5,
    note: 'v4 is node20. MUST move together with actions/download-artifact — deploy.yml uploads in one job and downloads in another, and a producer/consumer major mismatch breaks inside the release lane, after the tag is cut',
  },
  'actions/download-artifact': {
    minMajor: 5,
    note: 'v4 is node20. See the upload-artifact note — these two are a pair',
  },
  'actions/configure-pages': { minMajor: 6, note: 'v5 is node20' },
  'actions/deploy-pages': { minMajor: 5, note: 'v4 is node20' },
  'actions/upload-pages-artifact': {
    composite: true,
    note: 'composite — no Node runtime of its own, but it wraps upload-artifact internally, so it still wants to track upstream',
  },
  'docker/build-push-action': {
    minMajor: 7,
    note: 'v6 is node20. This one builds the shipped multi-arch image, so a bump is exercised only by a real tag',
  },
  'docker/login-action': { minMajor: 4, note: 'v3 is node20' },
  'docker/setup-buildx-action': {
    minMajor: 4,
    note: 'v3 is node20. v4 removed the `config`, `config-inline` and `install` inputs — none used here',
  },
  'softprops/action-gh-release': {
    minMajor: 3,
    note: 'v2 is node20. Publishes the GitHub Release in deploy.yml, so it is only exercised on a real tag',
  },
  'android-actions/setup-android': { minMajor: 4, note: 'v3 is node20' },
  'oven-sh/setup-bun': { minMajor: 2, note: 'v2 already declares node24' },
  'tailscale/github-action': { minMajor: 3, note: 'v3+ declares node24; v4 is current' },
  'renovatebot/github-action': {
    minMajor: 45,
    note: 'v44 is node20, v45 is the first node24 major. Pinned to a full version because this action publishes no moving major tag',
  },
  'aquasecurity/trivy-action': {
    composite: true,
    note: 'composite — the scanner runs in its own container, so no Node runtime applies',
  },
};

export interface ActionRef {
  action: string;
  version: string;
  file: string;
  line: number;
}

/** Files this gate examines. Sorted so the printed denominator is stable. */
export function workflowFiles(root = repoRoot): string[] {
  // `dot: true` is load-bearing: every path here lives under `.github`, and
  // Bun's Glob skips dot-directories by default — without it this returns an
  // empty set and the gate has nothing to fail on.
  return WORKFLOW_GLOBS.flatMap((g) => [...new Glob(g).scanSync({ cwd: root, dot: true })]).sort();
}

/**
 * Every `uses:` in one file, with the line it sits on.
 *
 * Comment lines are dropped first: a `uses:` inside the WHY comments these
 * workflows carry is documentation, and reading it as a real pin would make the
 * gate fail on prose.
 *
 * Local refs (`./.github/actions/...`) are deliberately NOT returned — they
 * carry no version to floor-check, and the file they point at is scanned in its
 * own right by {@link workflowFiles}.
 */
export function parseUses(source: string, file = ''): ActionRef[] {
  const refs: ActionRef[] = [];
  source.split('\n').forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    const m = raw.match(/^\s*(?:-\s*)?uses:\s*['"]?([^'"@\s]+)@([^'"\s]+)['"]?/);
    if (!m) return;
    const [, action, version] = m;
    if (!action || !version || action.startsWith('./')) return;
    refs.push({ action, version, file, line: i + 1 });
  });
  return refs;
}

/**
 * The major from a pinned ref, or null when there isn't one.
 *
 * Null is the honest answer for a commit-SHA pin: the runtime is not derivable
 * from a SHA without a network call, and this gate reports what it cannot
 * classify rather than waving it through.
 */
export function majorOf(version: string): number | null {
  const m = version.match(/^v?(\d+)(?:\.|$)/);
  return m ? Number(m[1]) : null;
}

export interface Findings {
  /** Pinned below the floor — the actual regression. */
  belowFloor: Array<{ ref: ActionRef; floor: RuntimeFloor; minMajor: number }>;
  /** Used but absent from the table, or pinned in a shape the gate cannot read. */
  unclassified: Array<{ ref: ActionRef; why: string }>;
  /** In the table but used nowhere — dead config. */
  unusedFloors: string[];
}

/** Classify every ref against the floor table, both directions. */
export function checkRefs(
  refs: ActionRef[],
  floors: Record<string, RuntimeFloor> = RUNTIME_FLOORS,
): Findings {
  const belowFloor: Findings['belowFloor'] = [];
  const unclassified: Findings['unclassified'] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const floor = floors[ref.action];
    if (!floor) {
      unclassified.push({
        ref,
        why: 'no entry in RUNTIME_FLOORS — add one recording its runtime, or remove the action',
      });
      continue;
    }
    seen.add(ref.action);
    if (floor.composite) continue;

    const major = majorOf(ref.version);
    if (major === null) {
      unclassified.push({
        ref,
        why: 'pinned to a commit SHA or an unreadable version — the runtime cannot be derived from it offline',
      });
      continue;
    }
    if (floor.minMajor !== undefined && major < floor.minMajor) {
      belowFloor.push({ ref, floor, minMajor: floor.minMajor });
    }
  }

  const unusedFloors = Object.keys(floors)
    .filter((a) => !seen.has(a))
    .sort();
  return { belowFloor, unclassified, unusedFloors };
}

function main(): void {
  const files = workflowFiles();
  const refs = files.flatMap((f) => parseUses(readFileSync(join(repoRoot, f), 'utf8'), f));

  if (refs.length === 0) {
    console.error(
      `check:action-runtimes: examined ${files.length} file(s) and found no \`uses:\` at all.\n` +
        'That is a broken scan, not a clean repo — the globs or the parser stopped matching.',
    );
    process.exit(1);
  }

  const { belowFloor, unclassified, unusedFloors } = checkRefs(refs);

  if (!belowFloor.length && !unclassified.length && !unusedFloors.length) {
    const distinct = new Set(refs.map((r) => r.action)).size;
    console.log(
      `Action runtimes: ${refs.length} pin(s) across ${distinct} action(s) in ${files.length} file(s), all at or above their runtime floor.`,
    );
    return;
  }

  if (belowFloor.length) {
    console.error('Actions pinned below their Node-runtime floor:\n');
    for (const { ref, floor, minMajor } of belowFloor) {
      console.error(
        `  ${ref.file}:${ref.line}  ${ref.action}@${ref.version} → needs v${minMajor}+`,
      );
      console.error(`    ${floor.note}`);
    }
    console.error(
      '\nA retired runtime is a warning first and a hard failure later — and for the\n' +
        'deploy.yml pins, the failure lands after the tag is cut.\n',
    );
  }

  if (unclassified.length) {
    console.error('Actions this gate cannot classify:\n');
    for (const { ref, why } of unclassified) {
      console.error(`  ${ref.file}:${ref.line}  ${ref.action}@${ref.version}`);
      console.error(`    ${why}`);
    }
    console.error('');
  }

  if (unusedFloors.length) {
    console.error('RUNTIME_FLOORS entries no workflow uses (dead config):\n');
    for (const a of unusedFloors) console.error(`  · ${a}`);
    console.error('\nDrop the entry. A rule that guards nothing still reads as though it does.\n');
  }

  process.exit(1);
}

if (import.meta.main) main();
