/**
 * Hunt query builders for the album-hunt modal (it shows the user exactly which
 * Soulseek search strings a hunt fires).
 *
 * These now live in @nicotind/core (`hunt-queries.ts`) as the single source shared
 * with the API hunter — no more hand-synced copy. The web bundle already imports
 * core value functions (the roles ladder), so esbuild tree-shakes the rest of core
 * (pino etc.) out. Re-exported here so the modal's `./lib/hunt-queries` import path
 * stays stable.
 */
export { baseQueries, skewedQueries, stripTitleQualifiers } from '@nicotind/core';
