import { describe, expect, it } from 'bun:test';
import { eslint } from './test-support.js';

// Through the REAL eslint.config.js, not a test config: a rule proven in isolation and never
// switched on is the safety feature nobody wired.
async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `(${m.message})`);
}

describe('eslint.config.js wiring', () => {
  it('bans a vitest import outside packages/web', async () => {
    const code = "import { it } from 'vitest';\nit('x', () => {});\n";
    expect(await ruleIds(code, 'packages/api/src/services/x.test.ts')).toContain(
      'no-restricted-imports',
    );
    expect(await ruleIds(code, 'scripts/x.test.ts')).toContain('no-restricted-imports');
  });

  it('allows vitest in packages/web, where it is the test runner', async () => {
    const code = "import { it } from 'vitest';\nit('x', () => {});\n";
    expect(await ruleIds(code, 'packages/web/src/app/x.spec.ts')).toEqual([]);
  });

  it('runs nicotind/shared-helpers on web and package-script sources', async () => {
    const code = 'export function expandHome(p: string) {\n  return p;\n}\n';
    expect(await ruleIds(code, 'packages/web/src/app/lib/x.ts')).toEqual([
      'nicotind/shared-helpers',
    ]);
    expect(await ruleIds(code, 'packages/e2e/scripts/lib/x.mjs')).toEqual([
      'nicotind/shared-helpers',
    ]);
  });

  it('runs nicotind/search-matching on API sources', async () => {
    const code = "export const q = 'SELECT id FROM library_artists WHERE name LIKE ?';\n";
    expect(await ruleIds(code, 'packages/api/src/routes/x.ts')).toEqual([
      'nicotind/search-matching',
    ]);
  });

  it('holds packages/web to no recommended rule yet (it needs @angular-eslint)', async () => {
    const code = 'const unused = 1;\n';
    expect(await ruleIds(code, 'packages/web/src/app/x.ts')).toEqual([]);
    expect(await ruleIds(code, 'packages/api/src/x.ts')).toEqual([
      '@typescript-eslint/no-unused-vars',
    ]);
  });
});
