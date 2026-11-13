/**
 * Builds the static demo into a GitHub Pages site (docs/demo-mode.md).
 *
 *   bun run scripts/build-demo.ts <site-dir> [--skip-audio]
 *
 * 1. the `demo` web bundle (`--base-href /NicotinD/demo/`) → <site>/demo/
 * 2. the snapshot, covers and audio, recorded from the real server over the
 *    pinned CC library → <site>/demo/demo-data, demo-media
 * 3. the smoke spec (playwright.demo.config.ts) against the staged site
 * 4. <site>/404.html: Pages has no rewrite rules, so a deep link or a reload
 *    under /NicotinD/demo/ lands on the site's one 404 page — which hands the
 *    path to the demo and lets its router take it from there.
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEMO_BASE_HREF = '/NicotinD/demo/';
export const DEMO_REDIRECT_KEY = 'nicotind_demo_redirect';

const repoRoot = resolve(import.meta.dir, '..');

function run(cmd: string[], cwd = repoRoot): void {
  const res = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (res.exitCode !== 0) throw new Error(`${cmd.join(' ')} exited ${res.exitCode}`);
}

/** The site's 404 page: a demo deep link goes back through the demo's entry. */
export function notFoundHtml(baseHref = DEMO_BASE_HREF): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NicotinD</title>
    <script>
      (function () {
        var base = ${JSON.stringify(baseHref)};
        var path = location.pathname;
        if (path.indexOf(base) === 0) {
          try {
            sessionStorage.setItem(${JSON.stringify(DEMO_REDIRECT_KEY)}, path.slice(base.length) + location.search + location.hash);
          } catch (e) {}
          location.replace(base);
        }
      })();
    </script>
  </head>
  <body>
    <p>Not found. <a href="/NicotinD/">NicotinD</a></p>
  </body>
</html>
`;
}

if (import.meta.main) {
  const site = resolve(process.argv[2] ?? 'site');
  const skipAudio = process.argv.includes('--skip-audio');
  const out = join(site, 'demo');
  // Staged as a site of its own and moved in only once the smoke spec passed
  // against it: a failed build must leave no half-demo to publish.
  const staging = join(site, '..', `.demo-staging-${process.pid}`);
  run(['bun', 'run', 'build:demo'], join(repoRoot, 'packages/web'));
  const dist = join(repoRoot, 'packages/web/dist-demo/browser');
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`no demo bundle at ${dist}`);
  rmSync(staging, { recursive: true, force: true });
  cpSync(dist, join(staging, 'demo'), { recursive: true });
  writeFileSync(join(staging, '404.html'), notFoundHtml());
  try {
    run([
      'bun',
      'run',
      'packages/e2e/demo/record-snapshot.ts',
      '--out',
      join(staging, 'demo'),
      ...(skipAudio ? ['--skip-audio'] : []),
    ]);
    if (!skipAudio) {
      const smoke = Bun.spawnSync(['bun', 'run', 'demo'], {
        cwd: join(repoRoot, 'packages/e2e'),
        env: { ...process.env, DEMO_SITE_DIR: staging },
        stdout: 'inherit',
        stderr: 'inherit',
      });
      if (smoke.exitCode !== 0) throw new Error('the demo smoke spec failed');
    }
    mkdirSync(site, { recursive: true });
    rmSync(out, { recursive: true, force: true });
    renameSync(join(staging, 'demo'), out);
    writeFileSync(join(site, '404.html'), notFoundHtml());
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`demo built into ${out}`);
}
