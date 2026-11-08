/**
 * The repo's local ESLint plugin: code-shape gates that used to be regex
 * `check:*` scripts (#1316). A rule reports in-editor with file:line; a script
 * only reported in CI. See docs/quality-gates.md.
 */
import lyricsSingleOwner from './lyrics-single-owner.js';
import coverWriters from './cover-writers.js';
import searchMatching from './search-matching.js';
import sharedHelpers from './shared-helpers.js';

export default {
  meta: { name: 'nicotind' },
  rules: {
    'lyrics-single-owner': lyricsSingleOwner,
    'cover-writers': coverWriters,
    'search-matching': searchMatching,
    'shared-helpers': sharedHelpers,
  },
};
