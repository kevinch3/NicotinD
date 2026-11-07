// Serve THIS worktree's web build to a real phone, over the tailnet only, so a UI change can be
// confirmed on-device before it is merged or released. docs/phone-preview.md has the why.
//
//   bun run phone-preview                 # build, stage, serve, expose on https://<host>.ts.net:8443
//   PREVIEW_SKIP_BUILD=1 bun run phone-preview   # reuse packages/web/dist
//   PREVIEW_OVERLAY=0 bun run phone-preview      # no viewport readout
//
// Isolation: a throwaway fixture library + its own data dir under .tmp-preview/ (never prod data),
// a different HTTPS port from anything already served, `tailscale serve` (tailnet-only, never
// Funnel), and only that port is turned off on exit.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const state = resolve(root, '.tmp-preview');
const port = process.env.PREVIEW_PORT ?? '8590';
const tsPort = process.env.PREVIEW_TS_PORT ?? '8443';
const overlay = process.env.PREVIEW_OVERLAY !== '0';

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

if (process.env.PREVIEW_SKIP_BUILD !== '1') run('bun', ['run', '--cwd', 'packages/web', 'build']);
const builtDist = resolve(root, 'packages/web/dist');
if (!existsSync(resolve(builtDist, 'index.html'))) throw new Error(`no web build at ${builtDist}`);

// Stage a copy: the overlay is injected here so the real dist (and the app source) stay clean.
const dist = resolve(state, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
cpSync(builtDist, dist, { recursive: true });
if (overlay) {
  const script = readFileSync(resolve(import.meta.dir, 'phone-preview/overlay.js'), 'utf8');
  const indexPath = resolve(dist, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  writeFileSync(indexPath, html.replace('</body>', `<script>${script}</script></body>`));
}

// Music is copied once and the data dir kept, so the account you create on the phone survives reruns.
const music = resolve(state, 'music');
if (!existsSync(music))
  cpSync(resolve(root, 'packages/e2e/fixtures/music'), music, { recursive: true });

const status = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
const dns = (JSON.parse(status.stdout || '{}').Self?.DNSName as string | undefined)?.replace(
  /\.$/,
  '',
);
if (!dns) throw new Error('tailscale is not running or has no MagicDNS name');
const url = `https://${dns}:${tsPort}`;

const server = spawn('bun', ['run', 'src/main.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NICOTIND_PORT: port,
    NICOTIND_MODE: 'external',
    NICOTIND_LIDARR_URL: 'http://127.0.0.1:1',
    NICOTIND_DATA_DIR: resolve(state, 'data'),
    NICOTIND_MUSIC_DIR: music,
    NICOTIND_WEB_DIST: dist,
    NICOTIND_RADIO_MIN_DURATION: '0',
  },
});

let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  spawnSync('tailscale', ['serve', `--https=${tsPort}`, 'off'], { stdio: 'inherit' });
  server.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', stop);

for (let i = 0; i < 60; i++) {
  const ok = await fetch(`http://127.0.0.1:${port}/api/health`).then(
    (r) => r.ok,
    () => false,
  );
  if (ok) break;
  await Bun.sleep(1000);
}
run('tailscale', ['serve', '--bg', `--https=${tsPort}`, `http://127.0.0.1:${port}`]);

console.log(`\nPhone preview is up (tailnet only): ${url}`);
console.log('First run: create the admin account on the phone; it persists in .tmp-preview/data.');
console.log(
  'Open it in Safari → Share → Add to Home Screen to test the standalone PWA. Ctrl-C stops it.\n',
);
