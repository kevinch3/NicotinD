import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import nicotind from './scripts/eslint-rules/index.js';

/**
 * Held to the recommended rules. `packages/web` is not: that needs
 * `@angular-eslint` (docs/quality-gates.md). It IS parsed, for the
 * `nicotind/*` code-shape rules below, which need no Angular awareness.
 */
const RECOMMENDED = ['packages/*/src/**/*.ts', 'src/**/*.ts', 'scripts/**/*.{ts,js}'];

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
