import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXEMPT, OWNERS } from './cover-writers.js';
import { lintReaches, lintWith, repoRoot, ruleIsOn } from './test-support.js';

const FILE = 'packages/api/src/routes/some-route.ts';
const lines = (code: string, file = FILE) =>
  lintWith('cover-writers', code, file).map((m) => m.line);

describe('nicotind/cover-writers — flags a write past the bump', () => {
  it('flags raw SQL that writes library_artwork, in every verb', () => {
    expect(lines(`db.run("INSERT INTO library_artwork (id) VALUES (?)", [id]);`)).toEqual([1]);
    expect(lines('db.run(`INSERT OR REPLACE INTO library_artwork (id) VALUES (?)`);')).toEqual([1]);
    expect(lines(`db.run('UPDATE OR IGNORE library_artwork SET id = ?', [a]);`)).toEqual([1]);
    expect(lines(`db.run('DELETE FROM library_artwork WHERE id = ?', [a]);`)).toEqual([1]);
    expect(lines(`db.run('REPLACE INTO library_artwork VALUES (?)', [a]);`)).toEqual([1]);
  });

  it('flags a direct replaceFolderCover, bare or as a member', () => {
    expect(lines('replaceFolderCover(dir, pic, true);')).toEqual([1]);
    expect(lines('sources.replaceFolderCover(dir, pic, true);')).toEqual([1]);
  });

  it('flags reaching the artist-override store by its directory', () => {
    expect(lines("const p = join(dataDir, 'artist-overrides', id + '.jpg');")).toEqual([1]);
  });

  it('flags the directory inside a path string or a template', () => {
    expect(lines("const p = join(dataDir, 'artist-overrides/' + id);")).toEqual([1]);
    expect(lines('const p = `${dataDir}/artist-overrides/${id}.jpg`;')).toEqual([1]);
    expect(lines('const p = `artist-overrides/${id}`;')).toEqual([1]);
    expect(lines("const p = dataDir + '\\\\artist-overrides\\\\' + id;")).toEqual([1]);
  });

  it('ignores a name that only contains the directory', () => {
    expect(lines("const k = 'artist-overrides-count';")).toEqual([]);
    expect(lines("const k = 'my-artist-overrides';")).toEqual([]);
  });

  it('flags it in a script, too', () => {
    const script = 'packages/api/src/scripts/some-script.ts';
    expect(lines(`db.run('DELETE FROM library_artwork WHERE id = ?', [a]);`, script)).toEqual([1]);
  });
});

describe('nicotind/cover-writers — stays quiet on legitimate use', () => {
  it('ignores a read or a join of library_artwork', () => {
    expect(lines(`db.query('SELECT cover_url FROM library_artwork WHERE id = ?');`)).toEqual([]);
    expect(lines('const q = `SELECT 1 FROM a JOIN library_artwork w ON w.id = a.id`;')).toEqual([]);
  });

  it('ignores the bumping entry points', () => {
    const src = [
      'setArtwork(db, "album", id, url);',
      'deleteArtwork(db, id, dir);',
      'writeArtistImageOverride(db, dataDir, id, bytes, type);',
      'deleteArtistImageOverride(db, dataDir, id);',
      'await applyAlbumCover(db, deps, id, req);',
    ].join('\n');
    expect(lines(src)).toEqual([]);
  });

  it('ignores a mention in a comment', () => {
    expect(lines('// DELETE FROM library_artwork happens in artwork-store\nconst y = 1;')).toEqual(
      [],
    );
  });

  it('allows an owner module to write', () => {
    expect(lines(`db.run('DELETE FROM library_artwork WHERE id = ?');`, OWNERS[0]!.file)).toEqual(
      [],
    );
  });
});

// The denominator. Each entry is proven against the write shape its module really has, both
// ways: the rule must fire on the module's own source anywhere else (so it watches something,
// and an entry for a module that stopped writing fails), and every owner must actually bump.
describe('the rule watches every registered writer', () => {
  const entries = [...OWNERS, ...EXEMPT];

  it('points every entry at a module that exists', () => {
    for (const e of entries) expect(existsSync(resolve(repoRoot, e.file))).toBe(true);
  });

  it("fires on each listed module's real source when it appears anywhere else", () => {
    for (const e of entries) {
      const source = readFileSync(resolve(repoRoot, e.file), 'utf8');
      const elsewhere = e.file.replace(/[^/]+$/, '__copy__$&');
      const fires = lintWith('cover-writers', source, elsewhere).length > 0;
      expect({ file: e.file, fires }).toEqual({ file: e.file, fires: true });
    }
  });

  it('every owner calls bumpCoverRev; no exempt module needs to', () => {
    for (const o of OWNERS) {
      const bumps = /\bbumpCoverRev\(/.test(readFileSync(resolve(repoRoot, o.file), 'utf8'));
      expect({ file: o.file, bumps }).toEqual({ file: o.file, bumps: true });
    }
  });

  it('is switched on, and reached by `bun run lint`, beside every listed module', async () => {
    // The routes tree too: that is where a new HTTP writer would land.
    const probes = [FILE, ...entries.map((e) => e.file.replace(/[^/]+$/, '__copy__$&'))];
    for (const probe of probes) {
      expect({ file: probe, on: await ruleIsOn('nicotind/cover-writers', probe) }).toEqual({
        file: probe,
        on: true,
      });
      expect({ file: probe, reached: await lintReaches(probe) }).toEqual({
        file: probe,
        reached: true,
      });
    }
  });
});
