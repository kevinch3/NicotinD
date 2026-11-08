import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// #1666 sweep guard. Every `/api/cover/<id>` URL must come from `lib/cover-url.ts`,
// the one place a cover's revision (`v=<rev>`) is spelled. A template or
// component concatenating the URL by hand drops the rev, and the browser then
// serves a replaced cover from its day-long cache. `CoverRef.coverRev` being
// required is the type half of the guard; this is the spelling half.
//
// Templates are swept too: the `nicotind/*` ESLint rules see .ts only, and most
// of the hand-built URLs lived in .html bindings.
const APP = join(__dirname, '..');
const HELPER = 'lib/cover-url.ts';

/**
 * A cover URL being *built*: the `/api/cover` prefix as a string that closes
 * right there — in single, double or back quotes — or runs straight into a
 * template interpolation. A literal that is nothing but the prefix exists only
 * to be glued to an id (`+`, `.concat`, `.join`), so how it is glued does not
 * matter. A server-built URL (`/api/cover/remote?u=`) and prose (`/api/cover/:id`)
 * do not match.
 */
const BUILDS_COVER_URL = /\/api\/cover\/?(?:['"`]|\$\{)/;

/** Comment lines in .ts and .html: prose about the route is not a build. */
const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*|<!--)/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    if (!/\.(ts|html)$/.test(name) || /\.(spec|stories)\.ts$/.test(name)) return [];
    return [p];
  });
}

function offenders(): Array<{ file: string; line: number; text: string }> {
  return walk(APP).flatMap((p) =>
    readFileSync(p, 'utf8')
      .split('\n')
      .map((text, i) => ({ file: relative(APP, p), line: i + 1, text }))
      .filter((l) => !COMMENT_LINE.test(l.text) && BUILDS_COVER_URL.test(l.text)),
  );
}

describe('cover URL sweep (#1666)', () => {
  // The denominator, part 1: the pattern recognises every way the URL was, or
  // could be, glued together — including the real pre-#1666 lines verbatim.
  it.each([
    [
      'the album page as it shipped',
      `[src]="selectedAlbum()!.coverArt ? '/api/cover/' + selectedAlbum()!.coverArt + '?size=300&token=' + auth.mediaToken() : undefined"`,
    ],
    [
      'a component as it shipped',
      'const url = this.server.apiUrl(`/api/cover/${track.coverArt}?size=80&token=${token}`);',
    ],
    ['the css backdrop as it shipped', 'return art ? `url(/api/cover/${art}?size=600)` : null;'],
    ['double quotes', `const u = "/api/cover/" + id;`],
    ['a prefix without its slash', `const u = '/api/cover' + '/' + id;`],
    ['.concat', `const u = '/api/cover/'.concat(id);`],
    ['a template-literal prefix', 'const u = `/api/cover/`.concat(id);'],
    ['.join', `const u = ['/api/cover', id].join('/');`],
  ])('matches %s', (_label, line) => {
    expect(BUILDS_COVER_URL.test(line)).toBe(true);
  });

  it.each([
    ['prose about the route', ' * `coverArt` is a cover *id* for `/api/cover/:id`, never a URL.'],
    ['a server-built remote URL', 'return `/api/cover/remote?u=${encodeURIComponent(raw)}`;'],
    ['a helper call', 'this.coverRevisions.url(songCover(track), 80, this.auth.mediaToken())'],
  ])('leaves %s alone', (_label, line) => {
    expect(BUILDS_COVER_URL.test(line)).toBe(false);
  });

  // Part 2: the sweep walked the whole app, templates included, and the pattern
  // still sees the one place that is allowed to build the URL.
  it('walks the whole app and finds the helper itself', () => {
    const files = walk(APP);
    expect(files.filter((f) => f.endsWith('.html')).length).toBeGreaterThan(50);
    expect(files.filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(200);
    expect(offenders().some((h) => h.file === HELPER)).toBe(true);
  });

  it('no file outside lib/cover-url.ts builds an /api/cover URL by hand', () => {
    const outside = offenders()
      .filter((h) => h.file !== HELPER)
      .map((h) => `${h.file}:${h.line}: ${h.text.trim()}`);
    expect(outside).toEqual([]);
  });
});
