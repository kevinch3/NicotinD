/**
 * The eight fixed theme hues (`--theme-hue-1…8`, styles.css; theme audit Q2):
 * colour for things that have none of their own, a coverless album or a genre.
 * Never for a control: the accent says "press me".
 */
export const THEME_HUE_COUNT = 8;

function hash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 1…8 for `key`, stable across sessions and devices. */
export function themeHueIndex(key: string): number {
  return (hash(key) % THEME_HUE_COUNT) + 1;
}

/** The hue token `key` wears, as a CSS value. */
export function themeHue(key: string): string {
  return `var(--theme-hue-${themeHueIndex(key)})`;
}
