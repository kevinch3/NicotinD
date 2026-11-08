/**
 * Acceptance test for the server tarball (#1742): unpack it somewhere with no
 * repository around, start it with nothing but Bun, and require
 * `GET /api/health` → 200 and `GET /` → 200 with the SPA's HTML.
 *
 *   bun run scripts/server-tarball-smoke.ts dist-server/nicotind-<ver>-server-linux-<arch>.tar.gz
 *
 * `GET /` is the regression guard for #1732: a tree without the built web UI
 * answers 503 "web UI not built", which is exactly what the tarball exists to
 * prevent. Run from a temp dir, never the checkout, so a missing file in the
 * tarball cannot be papered over by the repo next to it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { smokeEnv } from './server-tarball';

const PORT = 18_484;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);

async function waitFor(url: string, deadline: number): Promise<Response> {
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(1000);
  }
  throw new Error(`${url} never answered 200 (last: ${last})`);
}

async function main(): Promise<void> {
  const tarball = process.argv[2];
  if (!tarball) throw new Error('usage: server-tarball-smoke.ts <tarball>');

  const root = mkdtempSync(path.join(tmpdir(), 'nicotind-smoke-'));
  const untar = spawnSync('tar', ['-xzf', path.resolve(tarball), '-C', root], {
    stdio: 'inherit',
  });
  if (untar.status !== 0) throw new Error(`tar -x failed (exit ${untar.status})`);
  const [top] = readdirSync(root).filter((d) => d.startsWith('nicotind-'));
  if (!top) throw new Error('tarball has no nicotind-<ver>/ directory');
  const appDir = path.join(root, top);

  const server = spawn(process.execPath, ['run', 'src/main.ts'], {
    cwd: appDir,
    env: { ...process.env, ...smokeEnv(root, PORT) },
    stdio: 'inherit',
  });
  try {
    const deadline = Date.now() + TIMEOUT_MS;
    await waitFor(`http://127.0.0.1:${PORT}/api/health`, deadline);
    console.log('✓ GET /api/health → 200');
    const html = await (await waitFor(`http://127.0.0.1:${PORT}/`, deadline)).text();
    if (!/<html/i.test(html)) throw new Error('GET / answered 200 but not with the web UI HTML');
    console.log('✓ GET / → 200 (web UI)');
  } finally {
    server.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(
    `\n✗ server tarball smoke failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
