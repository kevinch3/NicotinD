import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LYRICS_API, LYRICS_API_METHODS, LYRICS_OWNER } from './lyrics-single-owner.js';
import { lintReaches, lintWith, repoRoot, ruleIsOn } from './test-support.js';

const FILE = 'packages/web/src/app/components/track-info-sheet/track-info-sheet.component.ts';
const lines = (code: string, file = FILE) =>
  lintWith('lyrics-single-owner', code, file).map((m) => m.line);

describe('nicotind/lyrics-single-owner — flags a second owner', () => {
  it('flags the sheet as it shipped before #1666 B1', () => {
    const src = [
      'class TrackInfoSheetComponent {',
      '  fetchLyricsNow() {',
      '    this.api.fetchLyrics(this.songId(), true).subscribe((l) => this.lyrics.set(l));',
      '  }',
      '  saveLyricsNow() {',
      '    this.api.saveLyrics(this.songId(), this.lyricsDraft()).subscribe();',
      '  }',
      '}',
    ].join('\n');
    expect(lines(src)).toEqual([3, 6]);
  });

  it('flags every registered method', () => {
    for (const m of LYRICS_API_METHODS) expect(lines(`api.${m}('s1');`)).toEqual([1]);
  });

  it('flags a reference that is not a call: a callback, a computed key, a destructure', () => {
    expect(lines('ids.map(this.api.getLyrics);')).toEqual([1]);
    expect(lines("api['deleteLyrics']('s1');")).toEqual([1]);
    expect(lines('const { setLyricsOffset } = api;')).toEqual([1]);
  });
});

describe('nicotind/lyrics-single-owner — stays quiet on legitimate use', () => {
  it('ignores the owner’s own methods and look-alike names', () => {
    expect(lines('lyrics.fetchFor(id, true);\nlyrics.save(id, t);\nlyrics.remove(id);')).toEqual(
      [],
    );
    expect(lines('this.fetchLyricsManually();\nconst getLyricsLabel = 1;')).toEqual([]);
  });

  it('ignores a mention in a comment or a string', () => {
    expect(lines("// used to call api.saveLyrics here\nconst s = 'getLyrics';")).toEqual([]);
  });

  it('exempts the owner and the module that defines the methods', () => {
    expect(lines('this.api.getLyrics(id);', LYRICS_OWNER)).toEqual([]);
    expect(lines('this.getLyrics(id);', LYRICS_API)).toEqual([]);
  });
});

// The denominator. A rule that silently matches nothing reports the same clean run as one that
// checked everything, so the method list is read off the real API service, proven against the
// real owner's call shapes, and the lint command is shown to reach every web source with it on.
describe('nicotind/lyrics-single-owner — what it watches', () => {
  it('registers every lyrics member LibraryApiService has, and nothing it lacks', () => {
    const api = readFileSync(resolve(repoRoot, LYRICS_API), 'utf8');
    const members = [...api.matchAll(/^ {2}(\w*[Ll]yrics\w*)\s*\(/gm)].map((m) => m[1]!);
    expect(members.sort()).toEqual([...LYRICS_API_METHODS].sort());
  });

  it('fires on every method the owner actually calls, when that code lives anywhere else', () => {
    const source = readFileSync(resolve(repoRoot, LYRICS_OWNER), 'utf8');
    const elsewhere = 'packages/web/src/app/components/__copy__lyrics.service.ts';
    const fired = new Set(
      lintWith('lyrics-single-owner', source, elsewhere).map((m) => m.message.split('`')[1]),
    );
    expect([...fired].sort()).toEqual([...LYRICS_API_METHODS].sort());
  });

  it('is on, and reached by `bun run lint`, for every non-spec web source file', async () => {
    const files: string[] = [];
    for await (const rel of new Glob('packages/web/src/**/*.ts').scan({ cwd: repoRoot })) {
      if (rel.includes('node_modules') || rel.endsWith('.spec.ts')) continue;
      files.push(rel);
    }
    // 409 web source files when the rule landed; a glob that stops matching drops this.
    expect(files.length).toBeGreaterThan(300);
    for (const file of files) {
      expect({ file, on: await ruleIsOn('nicotind/lyrics-single-owner', file) }).toEqual({
        file,
        on: true,
      });
      expect({ file, reached: await lintReaches(file) }).toEqual({ file, reached: true });
    }
  });

  it('is off for specs, which drive the API double directly', async () => {
    const spec = 'packages/web/src/app/services/lyrics.service.spec.ts';
    expect(await ruleIsOn('nicotind/lyrics-single-owner', spec)).toBe(false);
  });
});
