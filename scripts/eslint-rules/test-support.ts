import tsparser from '@typescript-eslint/parser';
import { Glob } from 'bun';
import { ESLint, Linter } from 'eslint';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import nicotind from './index.js';

export const repoRoot = resolve(import.meta.dir, '../..');

/** Run one `nicotind/*` rule alone over `code`, as if it lived at `file` (repo-relative). */
export function lintWith(rule: string, code: string, file: string): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat', cwd: repoRoot });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.{ts,js,mjs}'],
        languageOptions: { parser: tsparser as Linter.Parser },
        plugins: { nicotind },
        rules: { [`nicotind/${rule}`]: 'error' },
      },
    ],
    { filename: resolve(repoRoot, file) },
  );
}

/** The repo's real config, the one `bun run lint` loads. */
export const eslint = new ESLint({ cwd: repoRoot });

/** Whether the real config turns `rule` on for `file` (repo-relative). */
export async function ruleIsOn(rule: string, file: string): Promise<boolean> {
  const config = (await eslint.calculateConfigForFile(resolve(repoRoot, file))) as {
    rules?: Record<string, unknown>;
  };
  const setting = config.rules?.[rule];
  const severity = Array.isArray(setting) ? setting[0] : setting;
  return severity === 2 || severity === 'error';
}

/** The quoted globs `bun run lint` hands to eslint, read from package.json. */
export function lintGlobs(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return [...pkg.scripts.lint!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Whether `bun run lint` reaches `file` at all: a glob matches it and nothing ignores it. */
export async function lintReaches(file: string): Promise<boolean> {
  const rel = relative(repoRoot, resolve(repoRoot, file));
  if (!lintGlobs().some((g) => new Glob(g).match(rel))) return false;
  return !(await eslint.isPathIgnored(resolve(repoRoot, rel)));
}
