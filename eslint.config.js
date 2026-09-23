import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import nicotind from './scripts/eslint-rules/index.js';

/**
 * Held to the recommended rules. `packages/web` is not: that needs
 * `@angular-eslint` (docs/quality-gates.md). It IS parsed, for the
 * `nicotind/*` code-shape rules below, which need no Angular awareness.
 */
const RECOMMENDED = ['packages/*/src/**/*.ts', 'src/**/*.ts', 'scripts/**/*.{ts,js}'];

/** Each optional tag library, and the one module allowed to import it. */
export const TAG_LOADERS = {
  'node-id3': 'packages/api/src/services/audio-tags.ts',
  'music-metadata': 'packages/api/src/services/music-metadata-loader.ts',
};

/** @param {string} mod */
function tagLoaderBan(mod) {
  const source = `[source.value='${mod}']`;
  return {
    selector: `ImportExpression${source}, ImportDeclaration${source}[importKind!='type']`,
    message: `Load ${mod} through ${TAG_LOADERS[mod]}, the one shared lazy loader (#1315).`,
  };
}

export default [
  { ignores: ['**/node_modules/', '**/dist/'] },
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint, nicotind },
  },
  {
    files: RECOMMENDED,
    ignores: ['packages/web/**'],
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // One lazy loader per optional tag library (#1315): compilation-tagger carried
  // its own copies of both. Tests may import them directly to read real bytes.
  {
    files: ['packages/api/src/**/*.ts'],
    ignores: ['**/*.test.ts', ...Object.values(TAG_LOADERS)],
    rules: { 'no-restricted-syntax': ['error', ...Object.keys(TAG_LOADERS).map(tagLoaderBan)] },
  },
  ...Object.entries(TAG_LOADERS).map(([owned, file]) => ({
    files: [file],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...Object.keys(TAG_LOADERS)
          .filter((m) => m !== owned)
          .map(tagLoaderBan),
      ],
    },
  })),
  {
    // Web disables recommended rules it is not (yet) linted with.
    files: ['packages/web/**'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    // vitest hoists `vi.mock` and type-checks nothing; `bun test` runs
    // everything outside packages/web, where a vitest import is a trap.
    files: ['**/*.{ts,js,mjs}'],
    ignores: ['packages/web/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vitest', message: 'Outside packages/web, tests run on bun: import bun:test.' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/scripts/**/*.{ts,mjs}'],
    rules: { 'nicotind/shared-helpers': 'error' },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'nicotind/search-matching': 'error' },
  },
];
