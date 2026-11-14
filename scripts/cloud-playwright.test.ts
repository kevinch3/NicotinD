import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** The SessionStart hook that installs the Chromium the repo's Playwright expects (#1534). */
const repoRoot = join(import.meta.dir, '..');
const hook = join(repoRoot, 'scripts/cloud-playwright.sh');
const locked = /"playwright": \["playwright@([0-9][^"]*)"/.exec(
  readFileSync(join(repoRoot, 'bun.lock'), 'utf8'),
)![1];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloud-playwright-'));
  mkdirSync(join(dir, 'bin'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An `npx` that records its arguments and exits with `code`. */
function fakeNpx(code: number): void {
  writeFileSync(join(dir, 'bin', 'npx'), `#!/bin/sh\necho "$@" > "${dir}/args"\nexit ${code}\n`);
  chmodSync(join(dir, 'bin', 'npx'), 0o755);
}

function runHook(env: Record<string, string>) {
  return spawnSync('bash', [hook], {
    env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: repoRoot, ...env },
    encoding: 'utf8',
  });
}

const args = () => readFileSync(join(dir, 'args'), 'utf8').trim();

describe('cloud-playwright.sh', () => {
  it('does nothing outside a cloud session', () => {
    fakeNpx(0);
    const r = runHook({});
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(() => args()).toThrow();
  });

  it("installs chromium for the version bun.lock resolved, not package.json's range", () => {
    fakeNpx(0);
    const r = runHook({ CLAUDE_CODE_REMOTE: 'true' });
    expect(r.status).toBe(0);
    expect(args()).toBe(`-y playwright@${locked} install chromium`);
    expect(r.stdout.trim()).toBe(`playwright: chromium for ${locked} ready`);
  });

  it('warns without failing the session, naming what will not run', () => {
    fakeNpx(1);
    const r = runHook({ CLAUDE_CODE_REMOTE: 'true' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`could not install chromium for ${locked}`);
    expect(r.stderr).toContain('gates:storybook and e2e will not launch');
  });

  it('warns when bun.lock carries no playwright', () => {
    fakeNpx(0);
    writeFileSync(join(dir, 'bun.lock'), '{}\n');
    const r = runHook({ CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('no version in bun.lock');
    expect(() => args()).toThrow();
  });
});
