import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWLIST,
  scan,
  staleEntries,
  unreviewed,
  type AllowlistEntry,
} from './check-install-scripts';

/**
 * The gate's hard part is the DENOMINATOR, not the comparison. `node_modules/.bun` is a
 * store bun never prunes, so scanning it counts packages that nothing links to and that
 * `bun install` would therefore never run — the first draft of this gate reported four
 * such packages as findings. `scan` walks reachability from the workspace roots instead,
 * and these fixtures are what hold it to that.
 */
let root: string;

/** Write a package into bun's isolated store, optionally linking it so it is reachable. */
function storePackage(
  name: string,
  version: string,
  scripts: Record<string, string> | undefined,
  opts: { linkFromRoot?: boolean; siblingOf?: string } = {},
): void {
  const entry = join(root, 'node_modules', '.bun', `${name.replace('/', '+')}@${version}`);
  const dir = join(entry, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, scripts }));

  if (opts.linkFromRoot) {
    symlinkSync(dir, join(root, 'node_modules', name));
  }
  if (opts.siblingOf) {
    // Bun's isolated layout: a package's dependencies sit beside it in the SAME
    // `<store-entry>/node_modules/`, not in a nested one.
    const host = join(
      root,
      'node_modules',
      '.bun',
      `${opts.siblingOf.replace('/', '+')}@1.0.0`,
      'node_modules',
      name,
    );
    mkdirSync(join(host, '..'), { recursive: true });
    symlinkSync(dir, host);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'install-scripts-'));
  mkdirSync(join(root, 'node_modules', '.bun'), { recursive: true });

  storePackage('linked', '1.0.0', { postinstall: 'node install.js' }, { linkFromRoot: true });
  storePackage('transitive', '2.0.0', { install: 'node build.js' }, { siblingOf: 'linked' });
  storePackage('scoped', '1.0.0', undefined, { linkFromRoot: true });
  storePackage('@scope/deep', '3.0.0', { preinstall: 'node pre.js' }, { siblingOf: 'linked' });
  storePackage('quiet', '1.0.0', { test: 'bun test' }, { linkFromRoot: true });
  // In the store, linked from nowhere: a stale version left behind by an older lockfile.
  storePackage('orphan', '9.9.9', { postinstall: 'node download-the-world.js' });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scan', () => {
  it('finds a package linked from the workspace root', () => {
    expect(scan(root).map((p) => p.id)).toContain('linked@1.0.0');
  });

  it('follows bun’s isolated layout to a dependency beside its dependent', () => {
    expect(scan(root).map((p) => p.id)).toContain('transitive@2.0.0');
  });

  it('descends into a @scope', () => {
    expect(scan(root).map((p) => p.id)).toContain('@scope/deep@3.0.0');
  });

  it('ignores a package in the store that nothing links to', () => {
    // The whole reason this gate walks reachability. A stale store entry is not something
    // `bun install` runs, so reporting it is a false finding — and training people to
    // dismiss findings is how a gate stops being read.
    expect(scan(root).map((p) => p.id)).not.toContain('orphan@9.9.9');
  });

  it('ignores a package with no install hook', () => {
    expect(scan(root).map((p) => p.name)).not.toContain('quiet');
  });

  it('records every install hook, not just the first', () => {
    const many = mkdtempSync(join(tmpdir(), 'install-scripts-many-'));
    const dir = join(many, 'node_modules', '.bun', 'both@1.0.0', 'node_modules', 'both');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'both',
        version: '1.0.0',
        scripts: { preinstall: 'node a.js', postinstall: 'node b.js' },
      }),
    );
    symlinkSync(dir, join(many, 'node_modules', 'both'));
    expect(scan(many)[0]?.hooks).toBe('preinstall: node a.js | postinstall: node b.js');
    rmSync(many, { recursive: true, force: true });
  });

  it('returns nothing rather than throwing when the tree is not installed', () => {
    expect(scan(join(tmpdir(), 'install-scripts-does-not-exist'))).toEqual([]);
  });
});

describe('unreviewed', () => {
  const allow: AllowlistEntry[] = [
    { name: 'linked', hooks: 'postinstall: node install.js', reason: 'reviewed' },
  ];

  it('passes a package whose hook text matches what was reviewed', () => {
    const pkg = scan(root).filter((p) => p.name === 'linked');
    expect(unreviewed(pkg, allow)).toEqual([]);
  });

  it('flags a package with no entry at all', () => {
    const pkgs = scan(root).filter((p) => p.name === 'transitive');
    expect(unreviewed(pkgs, allow).map((u) => u.id)).toEqual(['transitive@2.0.0']);
  });

  it('flags a package whose install script CHANGED since it was reviewed', () => {
    // The reason entries are keyed on command text rather than version: a patch bump that
    // quietly starts downloading from a vendor host would sail past a name-only allowlist.
    const stale: AllowlistEntry[] = [
      { name: 'linked', hooks: 'postinstall: node something-else.js', reason: 'reviewed' },
    ];
    const flagged = unreviewed(
      scan(root).filter((p) => p.name === 'linked'),
      stale,
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.reviewedHooks).toBe('postinstall: node something-else.js');
  });
});

describe('staleEntries', () => {
  it('flags an entry that matches no installed package', () => {
    const allow: AllowlistEntry[] = [
      { name: 'linked', hooks: 'postinstall: node install.js', reason: 'reviewed' },
      { name: 'departed', hooks: 'install: node gone.js', reason: 'left the tree' },
    ];
    expect(staleEntries(scan(root), allow).map((s) => s.name)).toEqual(['departed']);
  });

  it('is what turns an empty scan into a failure rather than a pass', () => {
    // Both halves guard the denominator: if the walk ever breaks and returns nothing,
    // every entry reads as stale and the gate goes red instead of quietly green.
    expect(staleEntries([], ALLOWLIST)).toHaveLength(ALLOWLIST.length);
  });
});

describe('the real repository', () => {
  it('has an install-hook package to check (the denominator)', () => {
    // Deliberately NOT asserting the repo is clean here: after a lockfile change the
    // installed tree reflects the PREVIOUS install until someone re-installs. Cleanliness
    // is asserted by `bun run check:install-scripts` in CI, which runs against a tree
    // `bun install` just built from the lockfile. What belongs here is the logic and the
    // denominator.
    expect(scan().length).toBeGreaterThan(0);
  });

  it('gives every allowlist entry a reason', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.hooks).toMatch(/^(preinstall|install|postinstall): /);
    }
  });

  it('allows ffmpeg-static only because ci.yml neutralises it elsewhere', () => {
    // The one entry that fails the #1087 bar on its own. If it is ever allowed without
    // that containment, this gate would be blessing the exact defect it exists to catch —
    // so the pairing test has to keep existing.
    const ffmpeg = ALLOWLIST.find((a) => a.name === 'ffmpeg-static');
    expect(ffmpeg?.reason).toContain('FFMPEG_BIN');
    expect(ffmpeg?.reason).toContain('ci-ffmpeg-static.test.ts');
  });
});
