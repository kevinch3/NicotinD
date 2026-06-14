/**
 * Generates PWA icons AND the browser-tab favicon from a single brand SVG source
 * (the same mark the web manifest's icon-192/512 use — the manifest icon is the
 * reference). Run with: bun run generate-icons
 * Output: packages/web/public/icons/ and packages/web/public/favicon.ico
 *
 * favicon.ico is built with ImageMagick (`convert`) because sharp can't encode
 * .ico; this is a dev-only regeneration step (the outputs are committed), so the
 * dependency isn't needed in CI. If `convert` is missing the script keeps the
 * existing favicon.ico and the SVG/PNG favicons still suffice for modern browsers.
 */
import sharp from 'sharp';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const PUBLIC = join(import.meta.dir, '../public');
const OUT = join(PUBLIC, 'icons');

const SVG_SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#09090b"/>
  <circle cx="50" cy="50" r="40" fill="#6366f1"/>
  <polygon points="42,32 70,50 42,68" fill="#f4f4f5"/>
</svg>`;
const SVG_BUFFER = Buffer.from(SVG_SOURCE);

await mkdir(OUT, { recursive: true });

// 192×192 — standard Android icon
await sharp(SVG_BUFFER).resize(192, 192).png().toFile(join(OUT, 'icon-192.png'));
console.log('✓ icon-192.png');

// 512×512 — standard icon + splash screen source
await sharp(SVG_BUFFER).resize(512, 512).png().toFile(join(OUT, 'icon-512.png'));
console.log('✓ icon-512.png');

// 512×512 maskable — logo at 80% size on solid background (safe zone padding)
const logoAt410 = await sharp(SVG_BUFFER).resize(410, 410).png().toBuffer();
await sharp({
  create: { width: 512, height: 512, channels: 4, background: { r: 9, g: 9, b: 11, alpha: 1 } },
})
  .composite([{ input: logoAt410, gravity: 'center' }])
  .png()
  .toFile(join(OUT, 'icon-512-maskable.png'));
console.log('✓ icon-512-maskable.png');

// 180×180 — iOS apple-touch-icon
await sharp(SVG_BUFFER).resize(180, 180).png().toFile(join(OUT, 'apple-touch-icon.png'));
console.log('✓ apple-touch-icon.png');

// ── Browser-tab favicons (brand mark) ──────────────────────────────────────

// Vector favicon — crisp at any DPI; preferred by modern browsers.
await writeFile(join(OUT, 'icon.svg'), SVG_SOURCE);
console.log('✓ icon.svg');

// PNG favicons — fallbacks for browsers without SVG-favicon support.
await sharp(SVG_BUFFER).resize(32, 32).png().toFile(join(OUT, 'icon-32.png'));
await sharp(SVG_BUFFER).resize(16, 16).png().toFile(join(OUT, 'icon-16.png'));
console.log('✓ icon-32.png, icon-16.png');

// favicon.ico (16/32/48 multi-size) from the brand mark, via ImageMagick.
try {
  const tmp48 = join(OUT, '.ico-48.png');
  await sharp(SVG_BUFFER).resize(48, 48).png().toFile(tmp48);
  execFileSync('convert', [
    join(OUT, 'icon-16.png'),
    join(OUT, 'icon-32.png'),
    tmp48,
    join(PUBLIC, 'favicon.ico'),
  ]);
  await rm(tmp48);
  console.log('✓ favicon.ico (16/32/48)');
} catch (err) {
  console.warn(
    '⚠ favicon.ico not regenerated (ImageMagick `convert` unavailable); ' +
      'kept existing file. SVG/PNG favicons cover modern browsers.',
    err instanceof Error ? err.message : err,
  );
}

console.log(`\nIcons written to ${OUT}`);
