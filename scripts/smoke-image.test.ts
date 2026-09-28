import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * `smoke-image.sh` gates both the image CI builds and the image a release
 * pushes, before any floating tag moves (docs/deployment.md). Exercised with
 * stub `docker` and `curl` on PATH, so the verdicts are pinned without a
 * daemon: a smoke test that passes a broken image is worse than none.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const SCRIPT = join(repoRoot, 'scripts', 'smoke-image.sh');

let bin: string;

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'smoke-image-'));
});
afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
});

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

/** A `docker` whose inspect answers state/health from the given values. */
function stubDocker(state: string, health: string): void {
  stub(
    'docker',
    `case "$1" in
  run) echo cid ;;
  logs) echo "container log line" ;;
  inspect)
    case "$3" in
      *State.Status*) echo ${state} ;;
      *) echo ${health} ;;
    esac ;;
esac`,
  );
}

async function run(expected = '1.2.3'): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bash', SCRIPT, 'img@sha256:abc', expected], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SMOKE_POLL_ATTEMPTS: '3',
      SMOKE_POLL_INTERVAL: '0',
    },
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: await proc.exited, out };
}

describe('smoke-image.sh', () => {
  it('passes a healthy container serving the expected version', async () => {
    stubDocker('running', 'healthy');
    stub('curl', `echo '{"ok":true,"version":"1.2.3"}'`);
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('serving 1.2.3');
  });

  it('fails a healthy container serving a different version (the #457 shape)', async () => {
    stubDocker('running', 'healthy');
    stub('curl', `echo '{"ok":true,"version":"1.2.2"}'`);
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("reports version '1.2.2', expected '1.2.3'");
  });

  it('fails an image with no HEALTHCHECK instead of timing out', async () => {
    stubDocker('running', 'none');
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('no HEALTHCHECK');
  });

  it('fails a container that exits before becoming healthy', async () => {
    stubDocker('exited', 'starting');
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('never became healthy (state=exited');
  });

  it('fails a container that never turns healthy within the budget', async () => {
    stubDocker('running', 'starting');
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('never became healthy (state=running health=starting)');
  });
});
