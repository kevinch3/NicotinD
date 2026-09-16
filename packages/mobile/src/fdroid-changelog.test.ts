import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FDROID_CHANGELOG_LIMIT,
  changelogSection,
  formatEntry,
  toFdroidChangelog,
} from './fdroid-changelog.js';

const REAL_CHANGELOG = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'CHANGELOG.md'),
  'utf8',
);

describe('changelogSection', () => {
  const md = [
    '# Changelog',
    '',
    '## [0.6.56](https://example/compare) (2026-09-16)',
    '',
    '### Bug Fixes',
    '',
    '* **ci:** did a thing',
    '## [0.6.55](https://example/compare) (2026-09-16)',
    '',
    '* **mobile:** older thing',
  ].join('\n');

  it('takes only the requested version, stopping at the next heading', () => {
    const section = changelogSection(md, '0.6.56');
    expect(section).toContain('did a thing');
    expect(section).not.toContain('older thing');
  });

  it('does not treat a prefix as a match', () => {
    // '0.6.5' must not match '## [0.6.56]' — the bug a startsWith would have.
    expect(changelogSection(md, '0.6.5')).toBe('');
  });

  it('is empty for a version with no section', () => {
    expect(changelogSection(md, '9.9.9')).toBe('');
  });
});

describe('formatEntry', () => {
  it('strips links, the commit ref and the closes tail, keeping the PR number', () => {
    const line =
      '* **desktop:** pin the staged backend deps ([#1175](https://x/issues/1175)) ' +
      '([73567c2](https://x/commit/73567c2be92c2745257423fbce6fc90af22eeb01)), ' +
      'closes [#1174](https://x/issues/1174)';
    expect(formatEntry(line)).toBe('• desktop: pin the staged backend deps (#1175)');
  });

  it('strips a references tail with several issues', () => {
    const line =
      '* **mobile:** drop ML Kit ([#1172](https://x/1172)) ([d427cdb](https://x/c/d427cdb31)), ' +
      'references [#1170](https://x/1170) [#1168](https://x/1168)';
    expect(formatEntry(line)).toBe('• mobile: drop ML Kit (#1172)');
  });

  it('returns null for headings and blank lines', () => {
    expect(formatEntry('### Bug Fixes')).toBeNull();
    expect(formatEntry('')).toBeNull();
    expect(formatEntry('## [0.6.56](https://x) (2026-09-16)')).toBeNull();
  });

  it('leaves an entry with no scope or refs alone', () => {
    expect(formatEntry('* plain entry')).toBe('• plain entry');
  });
});

describe('toFdroidChangelog', () => {
  it('renders every entry when they fit, one per line, no headings', () => {
    const out = toFdroidChangelog(['### Bug Fixes', '', '* **a:** one', '* **b:** two'].join('\n'));
    expect(out).toBe('• a: one\n• b: two');
  });

  it('is empty for a section with no entries', () => {
    expect(toFdroidChangelog('### Bug Fixes\n')).toBe('');
  });

  it('drops whole entries and says how many, never cutting mid-entry', () => {
    const section = Array.from({ length: 30 }, (_, i) => `* **scope:** entry number ${i}`).join(
      '\n',
    );
    const out = toFdroidChangelog(section);
    expect(out.length).toBeLessThanOrEqual(FDROID_CHANGELOG_LIMIT);
    expect(out).toMatch(/\n…and \d+ more$/);
    // Every line except the note is a complete entry.
    for (const line of out.split('\n').slice(0, -1)) {
      expect(line).toMatch(/^• scope: entry number \d+$/);
    }
  });

  it('reports a count that matches what it actually kept', () => {
    const section = Array.from({ length: 30 }, (_, i) => `* **scope:** entry number ${i}`).join(
      '\n',
    );
    const out = toFdroidChangelog(section);
    const lines = out.split('\n');
    const claimed = Number(/…and (\d+) more/.exec(lines.at(-1) ?? '')?.[1]);
    // Making room for the note can drop a further entry; the note must still
    // agree with reality, which a count computed once would not.
    expect(claimed).toBe(30 - (lines.length - 1));
  });

  it('truncates a single oversized entry rather than returning nothing', () => {
    const out = toFdroidChangelog(`* ${'x'.repeat(900)}`);
    expect(out.length).toBeLessThanOrEqual(FDROID_CHANGELOG_LIMIT);
    expect(out.endsWith('…')).toBe(true);
  });

  it('fits the real current release section and carries no markdown or URLs', () => {
    const version = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8'),
    ).version as string;
    const section = changelogSection(REAL_CHANGELOG, version);
    expect(section).not.toBe('');
    const out = toFdroidChangelog(section);
    expect(out.length).toBeLessThanOrEqual(FDROID_CHANGELOG_LIMIT);
    expect(out).not.toContain('http');
    expect(out).not.toContain('](');
    expect(out).not.toContain('**');
  });
});
