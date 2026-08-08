import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The TV route fork must key off the BUILD-time signal, never the DOM one.
 *
 * `app.routes.ts` is evaluated when main.ts imports `appConfig`, and ES imports
 * are hoisted — so it runs *before* main.ts calls `applyTvBuildClass()`. A
 * module-scope `isTvUi()` (which reads the `tv-build` root class) is therefore
 * always false, and the whole TV tree silently never registers. That failure is
 * invisible: the app boots fine, just as the phone UI.
 *
 * Asserted as source text rather than behaviour because the bug *is* the
 * evaluation order — importing the module here would evaluate it under this
 * spec's timing, not the app's, and prove nothing.
 */
describe('app.routes TV fork', () => {
  // Comments are stripped first: the file explains *why* isTvUi is wrong here,
  // and a naive substring check matches that prose instead of the code.
  const src = readFileSync(join(__dirname, 'app.routes.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('selects the TV tree with isTvBuild(), not isTvUi()', () => {
    expect(src).toContain('isTvBuild()');
    expect(src).not.toContain('isTvUi(');
  });

  it('registers the TV shell route conditionally', () => {
    expect(src).toMatch(/\.\.\.\(isTvBuild\(\) \? \[tvShellRoute\(\)\] : \[\]\)/);
  });
});
