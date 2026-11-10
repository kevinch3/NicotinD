import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** The SessionStart hook that moves a cloud session onto `.nvmrc`'s Node (#1575). */
const repoRoot = join(import.meta.dir, '..');
const hook = join(repoRoot, 'scripts/cloud-node.sh');
const want = `v${readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim().replace(/^v/, '')}`;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloud-node-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeNode(binDir: string, version: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\necho ${version}\n`);
  chmodSync(join(binDir, 'node'), 0o755);
}

function runHook(env: Record<string, string>) {
  const envFile = join(dir, 'env');
  writeFileSync(envFile, '');
  const r = spawnSync('bash', [hook], {
    env: {
      PATH: `${join(dir, 'container')}:/usr/bin:/bin`,
      HOME: dir,
      CLAUDE_PROJECT_DIR: repoRoot,
      CLAUDE_ENV_FILE: envFile,
      NICOTIND_NODE_CACHE: join(dir, 'cache'),
      ...env,
    },
    encoding: 'utf8',
  });
  return { ...r, envFile: readFileSync(envFile, 'utf8') };
}

describe('cloud-node.sh', () => {
  it('does nothing outside a cloud session', () => {
    fakeNode(join(dir, 'container'), 'v22.22.0');
    const r = runHook({});
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.envFile).toBe('');
  });

  it("leaves PATH alone when the container's Node already matches", () => {
    fakeNode(join(dir, 'container'), want);
    const r = runHook({ CLAUDE_CODE_REMOTE: 'true' });
    expect(r.stdout.trim()).toBe(`node: ${want} (matches .nvmrc)`);
    expect(r.envFile).toBe('');
  });

  it('puts the cached .nvmrc Node first on PATH and says so', () => {
    fakeNode(join(dir, 'container'), 'v22.22.0');
    const bin = join(dir, 'cache', want, `node-${want}-linux-${arch}`, 'bin');
    fakeNode(bin, want);
    const r = runHook({ CLAUDE_CODE_REMOTE: 'true' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`node: ${want} from .nvmrc (container had v22.22.0)`);
    expect(r.envFile).toBe(`export PATH="${bin}:$PATH"\n`);
  });

  it('warns without failing the session when the download is unreachable', () => {
    fakeNode(join(dir, 'container'), 'v22.22.0');
    // A curl that always fails stands in for a sandbox with no route to nodejs.org.
    writeFileSync(join(dir, 'container', 'curl'), '#!/bin/sh\nexit 7\n');
    chmodSync(join(dir, 'container', 'curl'), 0o755);
    const r = runHook({ CLAUDE_CODE_REMOTE: 'true' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`could not install ${want}`);
    expect(r.envFile).toBe('');
  });
});
