import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/**
 * Issue #1127: `PlayerService` is dependency-free, so something else has to hand
 * it the `RadioProvider` that keeps the queue alive. For a year that was
 * `LayoutComponent.ngOnInit` — the **phone/desktop shell**. A TV build forks at
 * the route level and mounts `TvShellComponent` instead, so the call never ran
 * and `replenishRadio` returned on its first line for the life of the app:
 * every TV queue ended in silence, including the vibe tiles that set
 * `radio = true` themselves.
 *
 * What made it expensive is where the symptom appears. Nothing throws, nothing
 * logs, and the music stops twenty minutes later — pointing at the radio
 * formula, the network, the addon, anywhere but a missing registration in a
 * component the TV does not mount.
 *
 * The registration now lives in `RadioSourceService`, installed from the app
 * initializer, where no shell can forget it. This gate is what stops a shell
 * from quietly taking it back: a component that registers its own provider
 * re-creates exactly the "one shell has radio, the other does not" split.
 */
const ROOT = resolve(import.meta.dir, '..');
const WEB_SRC = resolve(ROOT, 'packages/web/src');

/** The one module allowed to hand `PlayerService` its radio source. */
const CANONICAL = 'packages/web/src/app/services/radio-source.service.ts';

function callSites(): string[] {
  const hits: string[] = [];
  for (const file of new Glob('**/*.ts').scanSync({ cwd: WEB_SRC, absolute: true })) {
    const rel = relative(ROOT, file);
    if (rel.endsWith('.spec.ts')) continue;
    const source = readFileSync(file, 'utf8');
    // The declaration in PlayerService is not a call site.
    if (/\.setRadioProvider\(/.test(source)) hits.push(rel);
  }
  return hits.sort();
}

describe('the radio source is registered exactly once, outside any shell', () => {
  it('has one call site, and it is RadioSourceService', () => {
    expect(callSites()).toEqual([CANONICAL]);
  });

  it('is installed from the app initializer, not from a component', () => {
    const config = readFileSync(resolve(ROOT, 'packages/web/src/app/app.config.ts'), 'utf8');
    expect(config).toContain('RadioSourceService');
    expect(config).toMatch(/inject\(RadioSourceService\)\.install\(\)/);
  });
});
