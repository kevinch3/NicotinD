/**
 * Generate the designed gradient covers for the curated playlists as committed
 * SVG assets under `packages/web/public/playlist-covers/<slug>.svg` (served by
 * the SPA at `/playlist-covers/<slug>.svg`, referenced from `playlists.cover_art`).
 *
 *   bun run packages/api/src/scripts/generate-playlist-covers.ts
 *
 * Pure + deterministic: the SVG markup comes from `playlistCoverSvg` (unit-tested),
 * so re-running only rewrites byte-identical files. Run from the repo root.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CURATED_PLAYLISTS } from '../services/curated-playlists.js';
import { RECIPES } from '../services/playlist-recipe.js';
import { playlistCoverSvg } from '../services/playlist-cover.js';

function main(): void {
  const outDir = resolve(process.cwd(), 'packages/web/public/playlist-covers');
  mkdirSync(outDir, { recursive: true });
  // Curated defs and automated recipes both point cover_art at
  // /playlist-covers/<slug>.svg, so generate covers for both.
  const defs = [...CURATED_PLAYLISTS, ...RECIPES];
  for (const def of defs) {
    const svg = playlistCoverSvg({ title: def.name, palette: def.palette });
    const file = resolve(outDir, `${def.slug}.svg`);
    writeFileSync(file, svg);
    console.log(`  ✓ ${def.slug}.svg`);
  }
  console.log(`\nWrote ${defs.length} covers to ${outDir}`);
}

main();
