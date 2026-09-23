/**
 * Fail when a dependency runs an install script nobody has reviewed.
 *
 *   bun run check:install-scripts
 *   bun run check:install-scripts --list   # print every hook, including reviewed ones
 *
 * WHY: `bun install` runs `preinstall`/`install`/`postinstall` for trusted packages, and
 * some of them fetch a binary from a host that is not the npm registry. That download is
 * a third party's uptime standing between a green tree and a release.
 *
 * It has already cost two outages. #1087: `ffmpeg-static` downloads its binary from a
 * GitHub release, every job's `bun install` ran it, and a transient failure there failed
 * `web-test` on the v0.6.33 release commit with nothing wrong in the code. The fix was to
 * stop the jobs that never use the binary from downloading it — `FFMPEG_BIN`, see
 * docs/quality-gates.md — not to retry.
 *
 * That fixed one package. The second arrived on 2026-09-21: `sharp@0.32.6`, pulled in
 * transitively by `@capacitor/assets`, downloads libvips from a GitHub release and falls
 * back to compiling from source when that fails. A 504 from the release CDN failed
 * `web-test`, both `e2e-shard` legs and `desktop-package` **at once**, on a four-file
 * artwork fix that could not have touched any of them — four attempts, 15.5 minutes. It
 * was removable for the same reason ffmpeg-static's was: nothing in CI used it.
 *
 * Two instances of one class is where a gate earns its place. Fixing the third by hand
 * after it withholds a release is the outcome this file exists to prevent.
 *
 * WHAT IT ASSERTS: every package with an install hook is on ALLOWLIST **at the exact hook
 * text it was reviewed with**. Keying on the command rather than the version is
 * deliberate — `esbuild` is in the tree at three versions and patch-bumps constantly, but
 * a package that *changes what its install script does* is exactly the event worth
 * re-reading, and a name-only allowlist would sleep through it.
 *
 * Both directions, per rule 5 of docs/quality-gates.md ("make allowlists
 * self-invalidating"): an unreviewed package fails, and so does an ALLOWLIST entry that
 * matches nothing. The second half is what stops this file from accumulating entries for
 * packages that left the tree years ago, quietly shrinking to a gate over an empty set.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

export interface InstallScriptPackage {
  /** `name@version`, the identity a reader can look up. */
  id: string;
  name: string;
  version: string;
  /** Every install hook, rendered as `hook: command`, joined — the reviewed text. */
  hooks: string;
}

export interface AllowlistEntry {
  name: string;
  /** The hook text this package was reviewed at. A change here fails the gate. */
  hooks: string;
  reason: string;
}

/**
 * Install hooks that have been read and found acceptable.
 *
 * The bar is the #1087 rule: **an install must not depend on a third-party download.**
 * A hook that resolves a prebuilt binary from the npm registry, or that does nothing
 * unless an opt-in env var is set, does not put a third party's uptime in front of the
 * release. One that fetches from a vendor's own release host does.
 *
 * Exactly one entry below fails that bar, and it is contained rather than removed —
 * see its reason.
 */
export const ALLOWLIST: AllowlistEntry[] = [
  {
    name: 'ffmpeg-static',
    hooks: 'install: node install.js',
    reason:
      'Downloads its binary from a GitHub release — the #1087 defect, kept because ' +
      '`desktop-package` genuinely needs the binary to package the Electron app. ' +
      'Contained, not removed: ci.yml sets `FFMPEG_BIN: /bin/false` workflow-wide so the ' +
      'installer exits early ("installed already") in every other job, and only the job ' +
      'that stages ffmpeg clears it. scripts/ci-ffmpeg-static.test.ts enforces that pairing ' +
      'and proves the skip against an unreachable proxy.',
  },
  {
    name: 'esbuild',
    hooks: 'postinstall: node install.js',
    reason:
      'Validates that the `@esbuild/<platform>` optional package the lockfile pins is ' +
      'present and its binary runs. Its only fetch is a fallback to registry.npmjs.org ' +
      '(install.js: `https://registry.npmjs.org/${pkg}/-/...tgz`) — the same registry the ' +
      'install itself came from, not a third-party host.',
  },
  {
    name: 'lmdb',
    hooks: 'install: node-gyp-build-optional-packages',
    reason:
      'Resolves a prebuilt `.node` from the optional `@lmdb/lmdb-<platform>` packages the ' +
      'lockfile pins, falling back to a local node-gyp build. No network beyond npm.',
  },
  {
    name: 'msgpackr-extract',
    hooks: 'install: node-gyp-build-optional-packages',
    reason:
      'Same mechanism as lmdb — prebuilt `.node` from optional `@msgpackr-extract/*` ' +
      'packages in the lockfile, local build as the fallback. No network beyond npm.',
  },
  {
    name: '@parcel/watcher',
    hooks: 'install: node scripts/build-from-source.js',
    reason:
      'A no-op unless `npm_config_build_from_source === "true"`, which nothing here sets: ' +
      'the script spawns node-gyp only inside that guard and otherwise exits having done ' +
      'nothing. The prebuilt `@parcel/watcher-<platform>` optional packages are what get used.',
  },
];

/** The package directories directly inside one `node_modules`, `@scope` expanded. */
function childPackages(nodeModules: string): string[] {
  if (!existsSync(nodeModules)) return [];
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(nodeModules);
  } catch {
    return [];
  }
  for (const name of names) {
    if (name === '.bin' || name === '.cache') continue;
    // `.bun` is the store, not a dependency: reachability is what this walk measures, so
    // enumerating the store here would put every cached package back in the denominator.
    if (name === '.bun') continue;
    if (name.startsWith('@')) {
      try {
        for (const inner of readdirSync(join(nodeModules, name))) {
          out.push(join(nodeModules, name, inner));
        }
      } catch {
        // a scope entry that is not a directory is not a package
      }
      continue;
    }
    out.push(join(nodeModules, name));
  }
  return out;
}

/**
 * Every installed package that runs an install hook.
 *
 * Reads the installed tree rather than the lockfile because **the lockfile records no
 * script metadata** — package identity and integrity only. The tree is the only place the
 * question can be answered.
 *
 * It walks **reachability from the workspace roots**, not `node_modules/.bun`. That store
 * is a cache bun never prunes: it holds versions no workspace links to any more, and an
 * earlier draft of this gate scanned it and reported four packages that `bun install`
 * would never run — a denominator inflated by garbage rather than shrunk by it, but wrong
 * the same way. What runs an install script is what bun links into the tree.
 *
 * Symlinks are followed on purpose and deduped by realpath: bun's layout makes every
 * `node_modules` entry a link into the store. A walk that refused to follow them would
 * report nothing at all.
 */
export function scan(root: string = ROOT): InstallScriptPackage[] {
  const workspaceRoots = [join(root, 'node_modules')];
  const packagesDir = join(root, 'packages');
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir)) {
      workspaceRoots.push(join(packagesDir, pkg, 'node_modules'));
    }
  }

  const found = new Map<string, InstallScriptPackage>();
  const visited = new Set<string>();
  const queue = workspaceRoots.flatMap(childPackages);

  while (queue.length > 0) {
    const dir = queue.pop()!;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue; // a broken link is not an installed package
    }
    if (visited.has(real)) continue;
    visited.add(real);

    let pkg: { name?: string; version?: string; scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
    } catch {
      continue; // unreadable or not JSON; not a package we can classify
    }

    // Two layouts, and the tree is only fully covered by following both. Nested/hoisted
    // puts a package's dependencies in its own `node_modules`. Bun's isolated layout —
    // what this repo installs — puts them as SIBLINGS in `.bun/<pkg>@<ver>/node_modules/`,
    // so the directory to enumerate is the one CONTAINING the package, stepping up twice
    // for a `@scope/name`. Walking only the nested case found one package out of seven.
    queue.push(...childPackages(join(real, 'node_modules')));
    if (pkg.name) {
      let container = dirname(real);
      if (pkg.name.startsWith('@')) container = dirname(container);
      queue.push(...childPackages(container));
    }

    if (!pkg.name || !pkg.version) continue;
    const hooks = (['preinstall', 'install', 'postinstall'] as const)
      .filter((h) => typeof pkg.scripts?.[h] === 'string')
      .map((h) => `${h}: ${pkg.scripts![h]}`)
      .join(' | ');
    if (!hooks) continue;
    found.set(`${pkg.name}@${pkg.version}`, {
      id: `${pkg.name}@${pkg.version}`,
      name: pkg.name,
      version: pkg.version,
      hooks,
    });
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Installed packages with no ALLOWLIST entry, or whose hook text has changed since review. */
export function unreviewed(
  packages: InstallScriptPackage[],
  allowlist: AllowlistEntry[] = ALLOWLIST,
): Array<InstallScriptPackage & { reviewedHooks?: string }> {
  return packages.flatMap((pkg) => {
    const entry = allowlist.find((a) => a.name === pkg.name);
    if (!entry) return [pkg];
    if (entry.hooks !== pkg.hooks) return [{ ...pkg, reviewedHooks: entry.hooks }];
    return [];
  });
}

/**
 * ALLOWLIST entries that match no installed package.
 *
 * An allowlist only checked in one direction rots: entries outlive the dependency and the
 * gate keeps reporting success over a set that quietly shrank. `check:ci-parity`'s own
 * allowlist is documented as missing this half; do not repeat it here.
 */
export function staleEntries(
  packages: InstallScriptPackage[],
  allowlist: AllowlistEntry[] = ALLOWLIST,
): AllowlistEntry[] {
  return allowlist.filter((a) => !packages.some((p) => p.name === a.name));
}

if (import.meta.main) {
  const packages = scan();

  // A walk that finds nothing is indistinguishable from a clean tree unless it says so.
  // Every entry is a symlink into bun's store, so a scan that stopped following them
  // would come back empty and read as a pass.
  if (packages.length === 0) {
    console.error(
      `\nNo package with an install hook found in the installed tree.\n\n` +
        `That is not a clean tree — it means the scan found nothing to look at. Run\n` +
        `\`bun install\` and try again.\n`,
    );
    process.exit(1);
  }

  if (process.argv.includes('--list')) {
    for (const pkg of packages) console.log(`  ${pkg.id}\n      ${pkg.hooks}`);
    console.log('');
  }

  const unknown = unreviewed(packages);
  if (unknown.length > 0) {
    console.error(`\n${unknown.length} package(s) run an install hook nobody has reviewed:\n`);
    for (const pkg of unknown) {
      console.error(`  ✗ ${pkg.id}\n      ${pkg.hooks}`);
      if (pkg.reviewedHooks) console.error(`      reviewed at: ${pkg.reviewedHooks}`);
    }
    console.error(
      `\nRead what the script does before allowing it. The bar is the #1087 rule: an\n` +
        `install must not depend on a third-party download. If it only resolves a prebuilt\n` +
        `binary from the npm registry, add it to ALLOWLIST with that reason. If it fetches\n` +
        `from a vendor's own host, the fix is to stop the jobs that do not use it from\n` +
        `running it at all — see docs/quality-gates.md.\n`,
    );
    process.exit(1);
  }

  const stale = staleEntries(packages);
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} ALLOWLIST entry/entries match no installed package: ` +
        `${stale.map((s) => s.name).join(', ')}\n\n` +
        `The dependency is gone, so the entry is now describing nothing. Delete it — an\n` +
        `allowlist that is never pruned turns this gate into a check over an empty set.\n`,
    );
    process.exit(1);
  }

  console.log(
    `Install scripts: ${packages.length} package(s) run an install hook, all reviewed ` +
      `(${ALLOWLIST.map((a) => a.name).join(', ')}).`,
  );
}
