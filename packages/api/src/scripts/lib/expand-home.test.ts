import { describe, it, expect, afterEach } from 'bun:test';
import { expandHome } from './expand-home.js';

const REAL_HOME = process.env.HOME;
afterEach(() => {
  process.env.HOME = REAL_HOME;
});

/**
 * The bug this file exists for: one of 30 copy-pasted `expandHome` helpers had
 * drifted to return `''` for a non-`~` path instead of the path itself. It lived
 * in `check-fragments.ts` — a documented CLI gate — so the gate had never run in
 * a Docker deployment, where `NICOTIND_DATA_DIR` is the absolute
 * `/data/nicotind`. Local dev uses the `~/.nicotind` default, which takes the
 * other branch, which is why it went unnoticed.
 */
describe('expandHome', () => {
  it('returns an absolute path unchanged — the case that was broken', () => {
    expect(expandHome('/data/nicotind')).toBe('/data/nicotind');
  });

  it('expands a leading ~', () => {
    process.env.HOME = '/home/someone';
    expect(expandHome('~/.nicotind')).toBe('/home/someone/.nicotind');
  });

  it('falls back to /root when HOME is unset (the container case)', () => {
    delete process.env.HOME;
    expect(expandHome('~/.nicotind')).toBe('/root/.nicotind');
  });

  it('leaves a relative path alone', () => {
    expect(expandHome('data/nicotind')).toBe('data/nicotind');
  });

  it('only treats a LEADING tilde as home', () => {
    // A path may legitimately contain `~` elsewhere.
    expect(expandHome('/srv/back~ups')).toBe('/srv/back~ups');
  });

  it('never returns empty for a non-empty input', () => {
    // The precise shape of the regression: an empty return made
    // `join(dataDir, 'nicotind.db')` collapse to a bare `nicotind.db`.
    for (const p of ['/data/nicotind', 'rel/path', '~/x', '/']) {
      expect(expandHome(p), p).not.toBe('');
    }
  });
});
