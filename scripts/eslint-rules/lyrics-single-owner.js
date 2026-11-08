/**
 * ESLint rule `nicotind/lyrics-single-owner`: only `LyricsService` talks to
 * the lyrics endpoints on the web client (#1666).
 *
 * WHY: the Track-info sheet used to call `LibraryApiService`'s lyrics methods
 * into a private signal, beside `LyricsService`, which the Now Playing panel,
 * the phone karaoke and the TV karaoke render. Neither copy heard the other's
 * writes, and since the karaoke stays mounted under the sheet, a Re-fetch or
 * Edit there left the old words on screen until the next track and back. B1
 * moved the sheet onto `LyricsService`; this is what stops copy #2 growing
 * back. A second caller is never the intended thing: the per-id store, its
 * request tokens and the offset-write queue (#1656) only hold when every
 * request goes through them.
 *
 * Any reference counts, not only a call: `this.api.getLyrics` passed as a
 * callback, `api['saveLyrics']`, or `const { fetchLyrics } = api` bypass the
 * owner just the same.
 *
 * Denominator: `lyrics-single-owner.test.ts` reads the method list off
 * `LibraryApiService` itself (every member whose name says lyrics must be
 * registered here), lints the owner's own source under a foreign filename and
 * requires the rule to fire for every registered method — so the registry is
 * proven against the real call shapes — and requires the rule to be on, and
 * the lint globs to reach, every non-spec web source file.
 */
import { relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

/** The one module allowed to call the lyrics endpoints. */
export const LYRICS_OWNER = 'packages/web/src/app/services/lyrics.service.ts';

/** Where the methods are defined (a definition is not a call). */
export const LYRICS_API = 'packages/web/src/app/services/api/library-api.service.ts';

/** `LibraryApiService`'s lyrics methods. */
export const LYRICS_API_METHODS = [
  'getLyrics',
  'fetchLyrics',
  'saveLyrics',
  'setLyricsOffset',
  'deleteLyrics',
];

/** @param {import('estree').Node} key @param {boolean} computed */
function nameOf(key, computed) {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: "Only LyricsService may call LibraryApiService's lyrics methods" },
    schema: [],
  },
  create(context) {
    const file = relative(repoRoot, context.filename).replace(/\\/g, '/');
    if (file === LYRICS_OWNER || file === LYRICS_API) return {};
    const watched = new Set(LYRICS_API_METHODS);
    /** @param {import('estree').Node} node @param {string | null} name */
    function check(node, name) {
      if (!name || !watched.has(name)) return;
      context.report({
        node,
        message:
          `\`${name}\` is a lyrics endpoint — go through LyricsService (${LYRICS_OWNER}) ` +
          'instead: a second owner of a song’s lyrics never hears the first one’s writes, ' +
          'so the karaoke shows stale words (#1666).',
      });
    }
    return {
      MemberExpression: (node) => check(node.property, nameOf(node.property, node.computed)),
      'ObjectPattern > Property': (node) => check(node.key, nameOf(node.key, node.computed)),
    };
  },
};
