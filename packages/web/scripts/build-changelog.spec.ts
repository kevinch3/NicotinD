import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChangelog, buildChangelogJson, writeIfChanged } from './build-changelog';

const SAMPLE_MD = `# Changelog

## [0.1.2](https://example.com/compare/v0.1.1...v0.1.2) (2026-01-02)

### Features

* **web:** add a thing ([abc123](https://example.com/commit/abc123))

### Bug Fixes

* **api:** fix a thing ([def456](https://example.com/commit/def456))
## [0.1.1](https://example.com/compare/v0.1.0...v0.1.1) (2026-01-01)

### Features

* **web:** initial feature
`;

describe('parseChangelog', () => {
  it('parses versions, dates, compare URLs, and sectioned items', () => {
    const entries = parseChangelog(SAMPLE_MD);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      version: '0.1.2',
      date: '2026-01-02',
      compareUrl: 'https://example.com/compare/v0.1.1...v0.1.2',
      sections: [
        {
          title: 'Features',
          items: ['**web:** add a thing ([abc123](https://example.com/commit/abc123))'],
        },
        {
          title: 'Bug Fixes',
          items: ['**api:** fix a thing ([def456](https://example.com/commit/def456))'],
        },
      ],
    });
  });

  it('is deterministic — parsing the same input twice yields identical output', () => {
    expect(parseChangelog(SAMPLE_MD)).toEqual(parseChangelog(SAMPLE_MD));
  });
});

describe('buildChangelogJson', () => {
  it('caps at 50 versions', () => {
    const many = Array.from(
      { length: 60 },
      (_, i) => `## [0.1.${i}](https://example.com/compare/a...b) (2026-01-01)\n`,
    ).join('');
    const parsed = JSON.parse(buildChangelogJson(many));
    expect(parsed).toHaveLength(50);
  });

  it('returns an empty array for an undefined source (CHANGELOG.md missing)', () => {
    expect(buildChangelogJson(undefined)).toBe('[]\n');
  });
});

describe('writeIfChanged', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file on first write and reports it wrote', () => {
    dir = mkdtempSync(join(tmpdir(), 'changelog-test-'));
    const outPath = join(dir, 'nested', 'changelog.json');

    const wrote = writeIfChanged(outPath, '[]\n');

    expect(wrote).toBe(true);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf8')).toBe('[]\n');
  });

  it('skips the write — and leaves mtime untouched — when content is unchanged', () => {
    dir = mkdtempSync(join(tmpdir(), 'changelog-test-'));
    const outPath = join(dir, 'changelog.json');
    writeIfChanged(outPath, '[]\n');
    const mtimeBefore = statSync(outPath).mtimeMs;

    const wroteAgain = writeIfChanged(outPath, '[]\n');

    expect(wroteAgain).toBe(false);
    expect(statSync(outPath).mtimeMs).toBe(mtimeBefore);
  });

  it('writes again when content actually differs', () => {
    dir = mkdtempSync(join(tmpdir(), 'changelog-test-'));
    const outPath = join(dir, 'changelog.json');
    writeIfChanged(outPath, '[]\n');

    const wroteAgain = writeIfChanged(outPath, '[{"version":"0.1.0"}]\n');

    expect(wroteAgain).toBe(true);
    expect(readFileSync(outPath, 'utf8')).toBe('[{"version":"0.1.0"}]\n');
  });
});
