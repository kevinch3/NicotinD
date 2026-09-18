import { describe, expect, it } from 'bun:test';
import {
  diffApkEntries,
  formatApkDiff,
  isIdentical,
  isSignatureEntry,
  parseZipinfoMethods,
  parseZipinfoNames,
  type ApkEntries,
} from './apk-diff.js';

const entries = (o: Record<string, string>): ApkEntries =>
  new Map(Object.entries(o).map(([k, v]) => [k, { sha256: v, method: 'defN' }]));

describe('isSignatureEntry', () => {
  it.each(['META-INF/MANIFEST.MF', 'META-INF/CERT.SF', 'META-INF/CERT.RSA', 'META-INF/KEY.DSA'])(
    'excludes %s, the way apksigcopier does',
    (name) => {
      expect(isSignatureEntry(name)).toBe(true);
    },
  );

  it('does NOT exclude app-metadata.properties — that is content, and a diff there is real', () => {
    expect(isSignatureEntry('META-INF/com/android/build/gradle/app-metadata.properties')).toBe(
      false,
    );
  });

  it('does not exclude a .SF deeper in the tree', () => {
    expect(isSignatureEntry('META-INF/services/foo.SF')).toBe(false);
  });

  it('does not exclude ordinary entries', () => {
    expect(isSignatureEntry('assets/public/ngsw.json')).toBe(false);
    expect(isSignatureEntry('classes.dex')).toBe(false);
  });
});

describe('diffApkEntries', () => {
  it('reports identical archives, and counts what it looked at', () => {
    const d = diffApkEntries(entries({ a: '1', b: '2' }), entries({ a: '1', b: '2' }));
    expect(isIdentical(d)).toBe(true);
    expect(d.examined).toBe(2);
    expect(d.ignored).toBe(0);
  });

  it('counts signature entries as ignored rather than comparing them', () => {
    const d = diffApkEntries(
      entries({ a: '1', 'META-INF/CERT.RSA': 'x' }),
      entries({ a: '1', 'META-INF/CERT.RSA': 'DIFFERENT' }),
    );
    expect(isIdentical(d)).toBe(true);
    expect(d.examined).toBe(1);
    expect(d.ignored).toBe(1);
  });

  it('names a changed entry with both digests', () => {
    const d = diffApkEntries(entries({ 'assets/x': '1' }), entries({ 'assets/x': '2' }));
    expect(d.changed).toEqual([
      {
        name: 'assets/x',
        a: { sha256: '1', method: 'defN' },
        b: { sha256: '2', method: 'defN' },
      },
    ]);
  });

  it('separates entries present on only one side', () => {
    const d = diffApkEntries(entries({ a: '1', gone: '2' }), entries({ a: '1', added: '3' }));
    expect(d.onlyInA).toEqual(['gone']);
    expect(d.onlyInB).toEqual(['added']);
  });

  it('catches a compression-method change even when the bytes match', () => {
    const a = new Map([['x', { sha256: '1', method: 'stor' }]]);
    const b = new Map([['x', { sha256: '1', method: 'defN' }]]);
    expect(diffApkEntries(a, b).changed).toHaveLength(1);
  });

  it('catches reordering — the same entries in a different order is a different archive', () => {
    const same = entries({ a: '1', b: '2' });
    const d = diffApkEntries(same, same, { a: ['a', 'b'], b: ['b', 'a'] });
    expect(d.orderDiffers).toBe(true);
    expect(isIdentical(d)).toBe(false);
  });

  it('ignores signature entries when judging order', () => {
    const same = entries({ a: '1' });
    const d = diffApkEntries(same, same, {
      a: ['META-INF/CERT.RSA', 'a'],
      b: ['a', 'META-INF/CERT.RSA'],
    });
    expect(d.orderDiffers).toBe(false);
  });
});

describe('parseZipinfo', () => {
  it('reads the compression method out of `zipinfo -l`', () => {
    const text = [
      'Archive:  app.apk',
      '-rw-r--r--  0.0 unx     5968 b-     2347 defN 81-Jan-01 01:01 assets/public/ngsw.json',
      '-rw-r--r--  0.0 unx      100 b-      100 stor 81-Jan-01 01:01 resources.arsc',
      '2 files, 6068 bytes uncompressed, 2447 bytes compressed:  59.7%',
    ].join('\n');
    const m = parseZipinfoMethods(text);
    expect(m.get('assets/public/ngsw.json')).toBe('defN');
    expect(m.get('resources.arsc')).toBe('stor');
    expect(m.size).toBe(2);
  });

  it('reads names in archive order and drops directory entries', () => {
    expect(parseZipinfoNames('AndroidManifest.xml\nassets/\nassets/x\n\n')).toEqual([
      'AndroidManifest.xml',
      'assets/x',
    ]);
  });
});

describe('formatApkDiff', () => {
  it('always states the denominator', () => {
    const out = formatApkDiff(diffApkEntries(entries({ a: '1' }), entries({ a: '1' })));
    expect(out).toContain('1 compared');
    expect(out).toContain('IDENTICAL');
  });

  it('pluralises honestly and says which entry', () => {
    const out = formatApkDiff(
      diffApkEntries(
        entries({ 'assets/public/ngsw.json': '1' }),
        entries({ 'assets/public/ngsw.json': '2' }),
      ),
    );
    expect(out).toContain('NOT REPRODUCIBLE — 1 entry differs.');
    expect(out).toContain('assets/public/ngsw.json');
  });
});
