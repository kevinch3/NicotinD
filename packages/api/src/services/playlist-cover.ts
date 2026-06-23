/**
 * Pure builders for the designed gradient playlist covers (Spotify-tile style).
 *
 * Kept dependency-free and deterministic — `scripts/generate-playlist-covers.ts`
 * writes the output of `playlistCoverSvg` to committed SVG files under
 * `packages/web/public/playlist-covers/<slug>.svg`, served as static SPA assets
 * and referenced from `playlists.cover_art`. SVG (not raster) so the covers stay
 * crisp at any tile size, tiny on disk, and need no `sharp`/image pipeline.
 */

/** A two-stop diagonal gradient (top-left → bottom-right). */
export interface CoverPalette {
  from: string;
  to: string;
}

export interface PlaylistCoverInput {
  title: string;
  palette: CoverPalette;
}

/** Square canvas size in px (also the rendered tile resolution). */
export const COVER_SIZE = 640;

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

/**
 * Greedy word-wrap of a title into at most `maxLines` lines of roughly
 * `maxChars` characters. A single overlong word is kept on its own line rather
 * than split. Overflow past `maxLines` is truncated with an ellipsis — our
 * curated titles are short, so this is a safety net, not the common path.
 */
export function wrapTitle(title: string, maxChars = 13, maxLines = 3): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (cur && candidate.length > maxChars) {
      lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
    return kept;
  }
  return lines;
}

/** Build the cover SVG markup for a playlist title + palette. */
export function playlistCoverSvg({ title, palette }: PlaylistCoverInput): string {
  const lines = wrapTitle(title);
  const fontSize = lines.length >= 3 ? 70 : lines.length === 2 ? 84 : 96;
  const lineHeight = Math.round(fontSize * 1.05);
  const bottomPad = 56;
  const startY = COVER_SIZE - bottomPad - (lines.length - 1) * lineHeight;
  const tspans = lines
    .map(
      (ln, i) =>
        `<tspan x="48" y="${startY + i * lineHeight}">${escapeXml(ln)}</tspan>`,
    )
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_SIZE}" height="${COVER_SIZE}" ` +
    `viewBox="0 0 ${COVER_SIZE} ${COVER_SIZE}">` +
    `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${palette.from}"/>` +
    `<stop offset="1" stop-color="${palette.to}"/>` +
    `</linearGradient>` +
    `<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0.45" stop-color="#000000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000000" stop-opacity="0.5"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="${COVER_SIZE}" height="${COVER_SIZE}" fill="url(#bg)"/>` +
    `<circle cx="${COVER_SIZE - 60}" cy="86" r="150" fill="#ffffff" fill-opacity="0.08"/>` +
    `<rect width="${COVER_SIZE}" height="${COVER_SIZE}" fill="url(#shade)"/>` +
    `<text font-family="Inter, Helvetica, Arial, sans-serif" font-weight="800" ` +
    `font-size="${fontSize}" fill="#ffffff" letter-spacing="-1">${tspans}</text>` +
    `</svg>`
  );
}
