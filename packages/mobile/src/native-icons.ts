/**
 * Brand-mark SVG sources for the native app icons (Android launcher + iOS
 * AppIcon), kept byte-for-byte consistent with the PWA manifest icon / favicon
 * the web ships (see packages/web/scripts/generate-icons.ts — the manifest icon
 * is the single reference mark). These are PURE builders: the dev-only
 * scripts/generate-native-icons.ts rasterizes them into the @capacitor/assets
 * source PNGs, so the SVG here stays the source of truth and is unit-tested.
 */

/** The NicotinD brand palette (identical to the web manifest mark). */
export const BRAND = {
  /** Near-black background (manifest `background_color`). */
  background: '#09090b',
  /** Indigo accent disc (manifest `theme_color`). */
  accent: '#6366f1',
  /** Off-white play glyph. */
  mark: '#f4f4f5',
} as const;

/**
 * Fraction of the icon canvas the logo occupies in the Android **adaptive**
 * foreground layer. Android launchers crop adaptive icons to a mask and only
 * guarantee the central ~66% ("safe zone") is visible, so the foreground art is
 * scaled down to sit inside it (the full-bleed mark is used for iOS / legacy).
 */
export const FOREGROUND_SAFE_ZONE = 0.66;

/**
 * Fraction of the splash canvas width the brand disc spans. Kept small so the
 * mark stays centred and is never cropped when the square source is letterboxed
 * to a device's aspect ratio (the dark field just extends).
 */
export const SPLASH_DISC_FRACTION = 0.22;

/** The bare brand glyph (indigo disc + play triangle), no background. */
function glyph(): string {
  return (
    `<circle cx="50" cy="50" r="40" fill="${BRAND.accent}"/>` +
    `<polygon points="42,32 70,50 42,68" fill="${BRAND.mark}"/>`
  );
}

/**
 * The full square brand mark on the solid background — used for iOS (which masks
 * its own corners and forbids transparency) and the legacy Android launcher.
 * Matches the web manifest icon-512 exactly.
 */
export function fullIconSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="${BRAND.background}"/>` +
    glyph() +
    `</svg>`
  );
}

/** Solid background layer for the Android adaptive icon. */
export function backgroundSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="${BRAND.background}"/>` +
    `</svg>`
  );
}

/**
 * Transparent foreground layer for the Android adaptive icon: the glyph scaled
 * about the canvas centre to {@link FOREGROUND_SAFE_ZONE} so launcher masks
 * never clip it.
 */
export function foregroundSvg(scale: number = FOREGROUND_SAFE_ZONE): string {
  // Scale about the centre (50,50): translate by 50*(1-scale) then scale.
  const offset = 50 * (1 - scale);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<g transform="translate(${offset} ${offset}) scale(${scale})">` +
    glyph() +
    `</g>` +
    `</svg>`
  );
}

/**
 * The launch / splash screen: the brand mark centred on the solid dark field, on
 * a square canvas (`@capacitor/assets` letterboxes it to each device aspect
 * ratio). The disc spans {@link SPLASH_DISC_FRACTION} of the width; the glyph's
 * local centre (50,50) is mapped to the canvas centre and scaled so its 80-unit
 * disc reaches that fraction.
 */
export function splashSvg(discFraction: number = SPLASH_DISC_FRACTION): string {
  const half = 50; // half of the 0..100 glyph viewBox
  // Glyph disc diameter is 80 in local units; scale so it spans `discFraction`
  // of the 100-unit canvas.
  const scale = (discFraction * 100) / 80;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="${BRAND.background}"/>` +
    `<g transform="translate(${half} ${half}) scale(${scale}) translate(${-half} ${-half})">` +
    glyph() +
    `</g>` +
    `</svg>`
  );
}
