#!/usr/bin/env bun
/**
 * Generates the multi-size app icon pack that `electron-builder.yml` points
 * at (`build: icon: build/icons`) and that `electron/paths.ts` resolves to
 * for the window / tray icons.
 *
 * Source: the PWA icon set at `<repo>/packages/web/public/icons/` —
 * `icon-512.png` (the largest raster) plus `apple-touch-icon.png` /
 * `icon-32.png` etc. electron-builder's expected file naming is
 * `<N>x<N>.png`, where the name advertises the rendered size. We output
 * 16, 24, 32, 48, 64, 128, 256, 512, and 1024 px.
 *
 * Why not `sharp`: adding a runtime dependency for one resize pass is
 * overkill; the desktop app already pulls in `ffmpeg-static` (a
 * devDependency) for the sidecar's stream transcode, and `ffmpeg` is the
 * most reliable image scaler available in any CI image. Run it with
 * `-vf scale=W:H` and `flags=lanczos` for a sharp downsample.
 *
 * Wired into `packages/desktop/package.json` `dist` chain between `build`
 * and `prepare-resources` so an icon refresh is automatic before every
 * `electron-builder` run. Skips with a warning when no source PNG exists
 * — a clean checkout without `packages/web/public/icons/icon-512.png`
 * silently leaves `build/icons/` empty, matching the pre-existing
 * behavior (electron-builder fell back to the framework default icon).
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const sourcePng = path.join(repoRoot, 'packages', 'web', 'public', 'icons', 'icon-512.png');
const outDir = path.join(__dirname, '..', 'build', 'icons');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

function findFfmpeg() {
  // System ffmpeg first (CI runners have it on PATH), then the desktop
  // package's own `ffmpeg-static` devDependency (its export is the path
  // to a bundled binary), so a local dev machine without system ffmpeg
  // still stages icons instead of silently skipping.
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (probe.status === 0) return 'ffmpeg';
  try {
    const ffmpegStatic = createRequire(import.meta.url)('ffmpeg-static');
    if (typeof ffmpegStatic === 'string' && existsSync(ffmpegStatic)) {
      return ffmpegStatic;
    }
  } catch {
    // ffmpeg-static not installed — fall through to the skip warning.
  }
  return null;
}

function stageSize(ffmpeg, size) {
  const file = path.join(outDir, `${size}x${size}.png`);
  const result = spawnSync(
    ffmpeg,
    ['-y', '-loglevel', 'error', '-i', sourcePng, '-vf', `scale=${size}:${size}:flags=lanczos`, file],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed to render ${size}x${size}.png`);
  }
}

function main() {
  if (!existsSync(sourcePng)) {
    console.warn(`No source PNG at ${sourcePng} — skipping icon stage.`);
    return;
  }
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.warn('ffmpeg not on PATH — skipping icon stage.');
    return;
  }
  mkdirSync(outDir, { recursive: true });
  for (const size of SIZES) {
    stageSize(ffmpeg, size);
  }
  const produced = readdirSync(outDir).sort((a, b) => {
    const na = Number(a.split('x')[0]);
    const nb = Number(b.split('x')[0]);
    return na - nb;
  });
  console.log(`Staged ${produced.length} icons into ${outDir}/`);
  for (const f of produced) console.log(`  ${f}`);
}

main();
