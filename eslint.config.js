import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import nicotind from './scripts/eslint-rules/index.js';

/**
 * Held to the recommended rules. `packages/web` is not: that needs
 * `@angular-eslint` (docs/quality-gates.md). It IS parsed, for the
 * `nicotind/*` code-shape rules and the haptics door below, which need no
 * Angular awareness.
 */
const RECOMMENDED = ['packages/*/src/**/*.ts', 'src/**/*.ts', 'scripts/**/*.{ts,js}'];

/** Each optional tag library, and the one module allowed to import it. */
export const TAG_LOADERS = {
  'node-id3': 'packages/api/src/services/audio-tags.ts',
  'music-metadata': 'packages/api/src/services/music-metadata-loader.ts',
};

/** The one module allowed to reach a vibration API (#1659). */
export const HAPTICS_MODULE = 'packages/web/src/app/lib/haptics.ts';

const hapticsBan = (what) => ({
  message: `${what} only inside ${HAPTICS_MODULE}: call \`haptic(event)\` from there, or the level setting and the throttle are skipped (#1659).`,
});

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
  // One haptics door (#1659): `navigator.vibrate` or the Haptics plugin anywhere
  // else would buzz past the user's Off/Reduced choice and the throttle.
  {
    files: ['packages/web/src/**/*.ts'],
    ignores: ['**/*.spec.ts', HAPTICS_MODULE],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='vibrate']", ...hapticsBan('Vibrate') },
        {
          selector: "CallExpression[callee.name='getCapacitorPlugin'][arguments.0.value='Haptics']",
          ...hapticsBan('Reach the Haptics plugin'),
        },
      ],
    },
  },
  // crypto.randomUUID only exists in a secure context, so it throws on the
  // plain-HTTP LAN origins most self-hosters use (#1724). One door: lib/uuid.ts.
  {
    files: ['packages/web/src/**/*.ts'],
    ignores: ['**/*.spec.ts', 'packages/web/src/app/lib/uuid.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          // No `object`: also catches window.crypto / globalThis.crypto.
          property: 'randomUUID',
          message:
            'Undefined on plain-HTTP origins (not a secure context). Use randomUuid() from lib/uuid.ts.',
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
  // One owner of a song's lyrics on the client (#1666); specs drive the API double directly.
  {
    files: ['packages/web/src/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: { 'nicotind/lyrics-single-owner': 'error' },
  },
  // A raw cover-byte write outside a module that bumps cover_rev serves new
  // bytes under the old, day-cached URL (#1666).
  {
    files: ['packages/api/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'nicotind/cover-writers': 'error' },
  },
];
