/**
 * Regenerates the @capacitor/assets SOURCE images (packages/mobile/assets/*.png)
 * from the brand-mark SVG in src/native-icons.ts — the same mark the PWA manifest
 * icon / favicon use (see packages/web/scripts/generate-icons.ts). This is a
 * dev-only step; its 1024² PNG outputs are committed so CI only needs
 * `@capacitor/assets generate` (no native `sharp` build in the mobile CI jobs).
 *
 * After running this, run `bun run icons:generate` (or `bunx @capacitor/assets
 * generate`) to rasterize the Android mipmaps + iOS AppIcon set from these
 * sources. Run with: bun run icons:source
 */
import sharp from 'sharp';
import opentype from 'opentype.js';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BANNER_HEIGHT,
  BANNER_LOCKUP_DISC_FRACTION,
  BANNER_LOCKUP_GAP,
  BANNER_WIDTH,
  backgroundSvg,
  bannerSvg,
  foregroundSvg,
  fullIconSvg,
  splashSvg,
  type BannerWordmark,
} from '../src/native-icons.js';

const ASSETS = join(import.meta.dir, '../assets');
// The Android TV banner goes straight into the committed res/ tree:
// @capacitor/assets has no banner concept, so no generate step covers it.
const ANDROID_RES = join(import.meta.dir, '../android/app/src/main/res');
const ICON_SIZE = 1024; // @capacitor/assets' expected icon source resolution.
const SPLASH_SIZE = 2732; // @capacitor/assets' expected splash source resolution.

await mkdir(ASSETS, { recursive: true });

async function render(svg: string, file: string, size: number): Promise<void> {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(ASSETS, file));
  console.log(`✓ ${file}`);
}

// Full opaque mark — iOS AppIcon + legacy Android launcher.
await render(fullIconSvg(), 'icon-only.png', ICON_SIZE);
// Android adaptive layers (foreground glyph sits inside the launcher safe zone).
await render(backgroundSvg(), 'icon-background.png', ICON_SIZE);
await render(foregroundSvg(), 'icon-foreground.png', ICON_SIZE);
// Launch / splash screen — brand mark on the dark field (light + dark identical:
// the app is dark-branded, so both modes show the same splash).
await render(splashSvg(), 'splash.png', SPLASH_SIZE);
await render(splashSvg(), 'splash-dark.png', SPLASH_SIZE);

// Android TV launcher banner (issue #388) — 320×180 at xhdpi, referenced by
// AndroidManifest.xml's android:banner="@drawable/banner". Google's TV
// guideline requires the app name in the banner, so the wordmark is converted
// to SVG paths via opentype.js + the committed Roboto Bold (assets/fonts/) —
// librsvg text with host fonts would make the output machine-dependent.
function bannerWordmark(text: string): BannerWordmark {
  const font = opentype.parse(
    readFileSync(join(import.meta.dir, '../assets/fonts/Roboto-Bold.ttf')).buffer as ArrayBuffer,
  );
  let size = 40;
  const widthAt = (s: number): number => font.getAdvanceWidth(text, s);
  // Shrink until the lockup keeps ≥5% side margins inside the 320px banner.
  const disc = BANNER_LOCKUP_DISC_FRACTION * BANNER_HEIGHT;
  const maxText = BANNER_WIDTH * 0.9 - disc - BANNER_LOCKUP_GAP;
  while (widthAt(size) > maxText) size -= 1;
  const capHeight = ((font.tables['os2']?.sCapHeight ?? 1456) / font.unitsPerEm) * size;
  return { pathD: font.getPath(text, 0, 0, size).toPathData(2), width: widthAt(size), capHeight };
}

const bannerDir = join(ANDROID_RES, 'drawable-xhdpi');
await mkdir(bannerDir, { recursive: true });
await sharp(Buffer.from(bannerSvg(bannerWordmark('NicotinD'))))
  .resize(BANNER_WIDTH, BANNER_HEIGHT)
  .png()
  .toFile(join(bannerDir, 'banner.png'));
console.log('✓ android/.../res/drawable-xhdpi/banner.png');

console.log(`\nSource icons written to ${ASSETS}`);
console.log('Next: bun run icons:generate  (rasterize native Android + iOS assets)');
