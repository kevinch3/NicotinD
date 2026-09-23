/**
 * The repo's local ESLint plugin: code-shape gates that used to be regex
 * `check:*` scripts (#1316). A rule reports in-editor with file:line; a script
 * only reported in CI. See docs/quality-gates.md.
 */
import searchMatching from './search-matching.js';
import sharedHelpers from './shared-helpers.js';

export default {
  meta: { name: 'nicotind' },
  rules: {
    'search-matching': searchMatching,
    'shared-helpers': sharedHelpers,
  },
};
