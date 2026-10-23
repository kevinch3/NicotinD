/**
 * Generated album sleeves for the demo catalog (docs/demo-mode.md).
 *
 * An SVG string, so the static demo can serve it as-is and the build script can
 * rasterise it once (in Chromium) into the `cover.jpg` the scanner picks up as
 * folder art. Like the tones, a pure function of the seed: the same album gets
 * the same sleeve everywhere.
 */
import { hashSeed, pick, randInt, seededRandom } from './random.js';

export interface CoverInput {
  artist: string;
  title: string;
  /** Defaults to `artist + title`; pass one to vary a sleeve without renaming it. */
  seed?: string;
  /** Seeded when omitted. A catalog names it, so a small catalog shows every motif. */
  motif?: CoverMotif;
}

export const COVER_MOTIFS = ['sun', 'waves', 'rings', 'grid'] as const;
export type CoverMotif = (typeof COVER_MOTIFS)[number];
const SIZE = 1000;

export function coverSvg(input: CoverInput): string {
  const seed = `cover:${input.seed ?? `${input.artist}\u0000${input.title}`}`;
  const rand = seededRandom(seed);
  // Unique per sleeve: SVG ids are document-global, so two inline covers sharing
  // `id="bg"` would both paint the first one's gradient.
  const gradientId = `demo-bg-${hashSeed(seed).toString(36)}`;
  const hue = randInt(rand, 0, 359);
  const hue2 = (hue + randInt(rand, 40, 160)) % 360;
  const bgTop = `hsl(${hue} 55% 22%)`;
  const bgBottom = `hsl(${hue2} 60% 12%)`;
  const accent = `hsl(${hue2} 80% 64%)`;
  const accentSoft = `hsl(${hue} 70% 70% / 0.35)`;
  const seeded = pick(rand, COVER_MOTIFS);
  const motif = input.motif ?? seeded;

  let art = '';
  switch (motif) {
    case 'sun': {
      const cy = randInt(rand, 330, 460);
      art += `<circle cx="500" cy="${cy}" r="${randInt(rand, 170, 240)}" fill="${accent}"/>`;
      for (let i = 0; i < 6; i++) {
        const y = cy + 40 + i * 34;
        art += `<rect x="0" y="${y}" width="${SIZE}" height="${8 + i * 3}" fill="${bgBottom}"/>`;
      }
      break;
    }
    case 'waves': {
      const count = randInt(rand, 6, 10);
      const amp = randInt(rand, 20, 60);
      for (let i = 0; i < count; i++) {
        const y = 220 + i * 52;
        const d = `M0 ${y} C 250 ${y - amp}, 750 ${y + amp}, ${SIZE} ${y}`;
        const stroke = i % 2 ? accent : accentSoft;
        art += `<path d="${d}" stroke="${stroke}" stroke-width="10" fill="none"/>`;
      }
      break;
    }
    case 'rings': {
      const cx = randInt(rand, 320, 680);
      const cy = randInt(rand, 300, 480);
      for (let r = 380; r > 20; r -= randInt(rand, 36, 60)) {
        const stroke = r % 2 ? accent : accentSoft;
        art += `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${stroke}" stroke-width="12" fill="none"/>`;
      }
      break;
    }
    case 'grid': {
      const step = randInt(rand, 70, 110);
      for (let x = step / 2; x < SIZE; x += step) {
        for (let y = step / 2; y < 720; y += step) {
          const r = 6 + rand() * (step / 3);
          art += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="${rand() < 0.2 ? accent : accentSoft}"/>`;
        }
      }
      break;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">`,
    `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="${bgTop}"/><stop offset="1" stop-color="${bgBottom}"/>`,
    `</linearGradient></defs>`,
    `<rect width="${SIZE}" height="${SIZE}" fill="url(#${gradientId})"/>`,
    art,
    `<rect x="0" y="760" width="${SIZE}" height="240" fill="${bgBottom}" opacity="0.82"/>`,
    `<text x="64" y="868" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="72" font-weight="700" fill="#fff">${escapeXml(input.title)}</text>`,
    `<text x="66" y="936" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="40" font-weight="400" fill="${accent}">${escapeXml(input.artist)}</text>`,
    `</svg>`,
  ].join('');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
