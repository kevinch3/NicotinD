import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'link-worktree.sh');

// A stub `bun` on PATH records how the script invoked it, so the test never installs.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'link-worktree-'));
  const bin = join(dir, 'bin');
  const tree = join(dir, 'wt');
  mkdirSync(bin);
  mkdirSync(tree);
  const log = join(dir, 'bun-args');
  writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash\necho "$PWD $*" > "${log}"\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  return { dir, bin, tree, log };
}

function run(tree: string, bin: string) {
  return Bun.spawnSync(['bash', SCRIPT, tree], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

describe('link-worktree.sh', () => {
  it("installs from the worktree's own lockfile", () => {
    const { tree, bin, log } = fixture();
    expect(run(tree, bin).exitCode).toBe(0);
    expect(readFileSync(log, 'utf8').trim()).toBe(`${tree} install --frozen-lockfile`);
  });

  it('removes an old symlinked tree without touching what it pointed at', () => {
    const { dir, tree, bin } = fixture();
    const mainStore = join(dir, 'main', 'node_modules', '.bun');
    mkdirSync(join(mainStore, 'pkg@1.0.0'), { recursive: true });
    mkdirSync(join(tree, 'node_modules'));
    symlinkSync(mainStore, join(tree, 'node_modules', '.bun'));
    mkdirSync(join(tree, 'packages', 'core', 'node_modules'), { recursive: true });

    expect(run(tree, bin).exitCode).toBe(0);
    expect(existsSync(join(tree, 'node_modules'))).toBe(false);
    expect(existsSync(join(tree, 'packages', 'core', 'node_modules'))).toBe(false);
    expect(existsSync(join(mainStore, 'pkg@1.0.0'))).toBe(true);
  });
});
