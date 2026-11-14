import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_PATH,
  NON_NPM,
  buildManifest,
  collect,
  normalizeLicense,
  packageUrl,
  type LicenceEntry,
  type Manifest,
} from './generate-licenses.js';

describe('normalizeLicense', () => {
  it('reads every historical shape', () => {
    expect(normalizeLicense({ license: 'MIT' })).toBe('MIT');
    expect(normalizeLicense({ license: { type: 'ISC' } })).toBe('ISC');
    expect(normalizeLicense({ licenses: [{ type: 'MIT' }] })).toBe('MIT');
    expect(normalizeLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT OR Apache-2.0)',
    );
  });

  it('says UNKNOWN rather than guessing', () => {
    expect(normalizeLicense({})).toBe('UNKNOWN');
    expect(normalizeLicense({ license: '  ' })).toBe('UNKNOWN');
  });
});

describe('packageUrl', () => {
  it('turns every repository form into an https link', () => {
    expect(packageUrl({ repository: 'honojs/hono' })).toBe('https://github.com/honojs/hono');
    expect(packageUrl({ repository: 'github:pinojs/pino' })).toBe('https://github.com/pinojs/pino');
    expect(packageUrl({ repository: { url: 'git+https://github.com/a/b.git' } })).toBe(
      'https://github.com/a/b',
    );
    expect(packageUrl({ repository: { url: 'git://github.com/a/b.git' } })).toBe(
      'https://github.com/a/b',
    );
    expect(packageUrl({ repository: 'git@github.com:a/b.git' })).toBe('https://github.com/a/b');
  });

  it('falls back to the homepage, then the npm page', () => {
    expect(packageUrl({ name: 'x', homepage: 'https://x.dev' })).toBe('https://x.dev');
    expect(packageUrl({ name: '@s/x' })).toBe('https://www.npmjs.com/package/@s/x');
  });
});

describe('collect', () => {
  let root: string;
  const pkg = (dir: string, json: object) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'licences-'));
    pkg(root, { name: 'root', dependencies: { a: '1', '@nicotind/core': '*' } });
    pkg(join(root, 'web'), { name: '@nicotind/web', dependencies: { a: '1' } });
    pkg(join(root, 'core'), { name: '@nicotind/core', dependencies: { b: '1' } });
    // A workspace package is a symlink in real installs; a copy resolves the same.
    pkg(join(root, 'node_modules/@nicotind/core'), {
      name: '@nicotind/core',
      dependencies: { b: '1' },
    });
    pkg(join(root, 'node_modules/a'), {
      name: 'a',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { c: '1' },
      optionalDependencies: { 'other-platform': '1' },
    });
    // A nested copy wins over the hoisted one, as in Node resolution.
    pkg(join(root, 'node_modules/a/node_modules/c'), {
      name: 'c',
      version: '2.0.0',
      license: 'ISC',
    });
    pkg(join(root, 'node_modules/c'), { name: 'c', version: '1.0.0', license: 'ISC' });
    pkg(join(root, 'node_modules/b'), { name: 'b', version: '3.0.0', license: 'Apache-2.0' });
    pkg(join(root, 'node_modules/devonly'), { name: 'devonly', version: '1.0.0', license: 'MIT' });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists the production closure once per version, with every surface that ships it', () => {
    const got = collect(root, [
      { dir: '.', surface: 'server' },
      { dir: 'web', surface: 'web' },
    ]);
    const ids = got.map((e) => `${e.name}@${e.version}`).sort();
    expect(ids).toEqual(['a@1.0.0', 'b@3.0.0', 'c@2.0.0']);
    expect(got.find((e) => e.name === 'a')!.surfaces.sort()).toEqual(['server', 'web']);
  });

  it('skips what the production install prunes, and everything only it pulled in', () => {
    pkg(join(root, 'tooled'), { name: '@nicotind/tooled', dependencies: { b: '1', tool: '1' } });
    pkg(join(root, 'node_modules/tool'), {
      name: 'tool',
      version: '1.0.0',
      license: 'FSL-1.1-Apache-2.0',
      dependencies: { devonly: '1' },
    });
    const got = collect(root, [{ dir: 'tooled', surface: 'server' }], ['tool']);
    expect(got.map((e) => e.name)).toEqual(['b']);
  });

  it('throws on a missing required dependency instead of dropping it', () => {
    pkg(join(root, 'broken'), { name: '@nicotind/broken', dependencies: { gone: '1' } });
    expect(() => collect(root, [{ dir: 'broken', surface: 'server' }])).toThrow(/gone/);
  });
});

describe('buildManifest', () => {
  it('is sorted and stable, so an unchanged tree writes an unchanged file', () => {
    const e = (name: string, surfaces: LicenceEntry['surfaces']): LicenceEntry => ({
      name,
      version: '1',
      license: 'MIT',
      url: 'https://x',
      surfaces,
    });
    const m = buildManifest(
      [e('zod', ['server', 'web']), e('Angular', ['web'])],
      [e('Bun', ['server'])],
    );
    expect(m.packages.map((p) => p.name)).toEqual(['Angular', 'Bun', 'zod']);
    expect(m.packages[2]!.surfaces).toEqual(['web', 'server']);
  });
});

/**
 * Licences a dependency of an AGPL-3.0-only program can carry. An `OR`
 * expression passes when any branch does, an `AND` only when all do.
 */
const COMPATIBLE = new Set([
  '0BSD',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/** Packages whose licence is not compatible, each with the issue that decides it. */
const UNDECIDED: Record<string, string> = {};

function compatible(expr: string): boolean {
  const e = expr.replace(/^\((.*)\)$/, '$1');
  if (e.includes(' OR ')) return e.split(' OR ').some(compatible);
  if (e.includes(' AND ')) return e.split(' AND ').every(compatible);
  return COMPATIBLE.has(e.trim());
}

describe(`the committed ${MANIFEST_PATH}`, () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, '..', MANIFEST_PATH), 'utf8'),
  ) as Manifest;

  it('carries the npm closure and every non-npm entry', () => {
    // Asserts its own denominator: an empty or truncated manifest passes nothing below.
    expect(manifest.packages.length).toBeGreaterThan(100);
    for (const extra of NON_NPM) expect(manifest.packages.map((p) => p.name)).toContain(extra.name);
  });

  it('declares a licence for every package', () => {
    expect(manifest.packages.filter((p) => p.license === 'UNKNOWN').map((p) => p.name)).toEqual([]);
  });

  it('holds nothing an AGPL-3.0-only program cannot ship, outside the recorded exceptions', () => {
    const bad = manifest.packages
      .filter((p) => !compatible(p.license) && !(p.name in UNDECIDED))
      .map((p) => `${p.name}@${p.version} (${p.license})`);
    expect(bad).toEqual([]);
  });
});
