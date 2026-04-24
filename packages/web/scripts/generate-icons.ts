/**
 * Generates PWA icons from an SVG source using sharp.
 * Run with: bun run generate-icons
 * Output: packages/web/public/icons/
 */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = join(import.meta.dir, '../public/icons');

const SVG_SOURCE = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#09090b"/>
  <circle cx="50" cy="50" r="40" fill="#6366f1"/>
  <polygon points="42,32 70,50 42,68" fill="#f4f4f5"/>
</svg>`);

await mkdir(OUT, { recursive: true });

// 192×192 — standard Android icon
await sharp(SVG_SOURCE).resize(192, 192).png().toFile(join(OUT, 'icon-192.png'));
console.log('✓ icon-192.png');

// 512×512 — standard icon + splash screen source
await sharp(SVG_SOURCE).resize(512, 512).png().toFile(join(OUT, 'icon-512.png'));
console.log('✓ icon-512.png');

// 512×512 maskable — logo at 80% size on solid background (safe zone padding)
const logoAt410 = await sharp(SVG_SOURCE).resize(410, 410).png().toBuffer();
await sharp({
  create: { width: 512, height: 512, channels: 4, background: { r: 9, g: 9, b: 11, alpha: 1 } },
})
  .composite([{ input: logoAt410, gravity: 'center' }])
  .png()
  .toFile(join(OUT, 'icon-512-maskable.png'));
console.log('✓ icon-512-maskable.png');

// 180×180 — iOS apple-touch-icon
await sharp(SVG_SOURCE).resize(180, 180).png().toFile(join(OUT, 'apple-touch-icon.png'));
console.log('✓ apple-touch-icon.png');

console.log(`\nIcons written to ${OUT}`);
