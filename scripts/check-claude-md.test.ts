import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCheckableIdentifier,
  brokenDocLinks,
  EXTERNAL_SYMBOLS,
  indexEntries,
  MAX_ENTRY_CHARS,
  MAX_CLAUDE_MD_BYTES,
  MAX_INDEX_SECTION_BYTES,
  indexSectionSlugs,
  sectionMismatches,
  MIN_PLAUSIBLE_ENTRIES,
  entryProse,
} from './check-claude-md.js';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

/**
 * Issue #255. The gate is a heuristic, and a heuristic that cries wolf gets
 * muted — so the filter's job is to reject everything it can't make a *strong*
 * claim about. Measured against the real CLAUDE.md it selects 238 identifiers
 * with zero false positives; these tests pin the rules that get it there.
 */
describe('isCheckableIdentifier', () => {
  it('accepts camelCase and PascalCase symbols — the strong claims', () => {
    for (const s of [
      'queueNext',
      'SongMenuService',
      'addColumnIfMissing',
      'setInputValue',
      'ensureWebBuild()', // call form is normalised by the caller
    ]) {
      expect(isCheckableIdentifier(s), s).toBe(true);
    }
  });

  it('rejects prose, flags and paths that merely sit in backticks', () => {
    for (const s of [
      'off', // a value in prose
      'genre', // a bare noun
      '--apply', // a CLI flag
      'packages/api/src/db.ts', // a path
      'bun run test', // a command
      'GET /api/library/albums', // a route
      'library_songs', // snake_case: a DB table, not a code symbol
      'kind', // short + lowercase
    ]) {
      expect(isCheckableIdentifier(s), s).toBe(false);
    }
  });

  it('rejects SCREAMING_CASE — env vars and constants are named by convention', () => {
    // These are real and greppable, but the convention makes them noisy to
    // check (many live only in .env.example or a compose file).
    expect(isCheckableIdentifier('NICOTIND_MUSIC_DIR')).toBe(false);
    expect(isCheckableIdentifier('MATCH_BUCKET')).toBe(false);
  });

  it('rejects member access — `a.b` is two claims, not one', () => {
    expect(isCheckableIdentifier('player.queueNext')).toBe(false);
  });

  it('rejects allowlisted deliberate non-code mentions', () => {
    // `oauth` is documented as "proposed — not yet implemented"; `ApiService`
    // and `SpotdlPlugin` are named precisely because they DON'T exist.
    expect(isCheckableIdentifier('oauth')).toBe(false);
    expect(isCheckableIdentifier('dataGroups')).toBe(false);
    expect(isCheckableIdentifier('ApiService')).toBe(false);
    expect(isCheckableIdentifier('SpotdlPlugin')).toBe(false);
  });

  it('rejects `castv2` on its own merits, not via the allowlist', () => {
    // It used to be allowlisted as "npm package (Chromecast protocol)" — but it
    // is not a dependency of this repo and never was; the cast feature was only
    // ever a proposal. The strong-claim filter rejects it anyway (no internal
    // capital), so removing that entry changed nothing here.
    expect(isCheckableIdentifier('castv2')).toBe(false);
  });
});

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

/**
 * The map is checked in BOTH directions on purpose. An allowlist only grows and
 * eventually mutes the gate it belongs to; this one breaks the build if a
 * symbol comes home, or if CLAUDE.md stops naming it.
 */
describe('EXTERNAL_SYMBOLS', () => {
  const claudeMd = execFileSync('cat', [resolve(REPO_ROOT, 'CLAUDE.md')], { encoding: 'utf8' });

  it('lists only symbols that genuinely are NOT in this repo', () => {
    for (const [sym] of EXTERNAL_SYMBOLS) {
      let found = '';
      try {
        found = execFileSync(
          'git',
          ['grep', '-l', '-w', '--', sym, ':!*.md', ':!*.lock', ':!scripts/check-claude-md.ts'],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        ).trim();
      } catch {
        found = ''; // git grep exits 1 on no match
      }
      expect(found, `${sym} is in this repo — drop it from EXTERNAL_SYMBOLS`).toBe('');
    }
  });

  it('lists only symbols the index still names', () => {
    // #934 moved the entries out of CLAUDE.md and #1240 split them across
    // sections, so the corpus is every file — asserting against one of them
    // would fail every symbol that relocated.
    const corpus = [
      claudeMd,
      readFileSync(resolve(REPO_ROOT, 'docs', 'index.md'), 'utf8'),
      ...indexSectionSlugs().map((s) =>
        readFileSync(resolve(REPO_ROOT, 'docs', 'index', `${s}.md`), 'utf8'),
      ),
    ].join('\n');
    for (const [sym] of EXTERNAL_SYMBOLS) {
      expect(corpus.includes(`\`${sym}\``), `the index no longer names ${sym}`).toBe(true);
    }
  });

  it('records where each one actually lives', () => {
    // "it's elsewhere" without an address is the wrong turn it exists to prevent.
    for (const [sym, where] of EXTERNAL_SYMBOLS) {
      expect(where, sym).toMatch(/slskd-addon .+\.ts:\d+/);
    }
  });
});

describe('brokenDocLinks', () => {
  it('flags a docs/ link with no file behind it', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-md-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'real.md'), '# real');

    const md = 'see [a](docs/real.md) and [b](docs/ghost.md) and [c](docs/real.md)';
    expect(brokenDocLinks(md, root)).toEqual(['docs/ghost.md']);

    rmSync(root, { recursive: true, force: true });
  });

  it('returns nothing when every link resolves', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-md-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'a.md'), '# a');
    expect(brokenDocLinks('[x](docs/a.md)', root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

/**
 * The size budget (this file's own header calls it "an index, kept deliberately
 * small"; nothing measured that, and it reached 186 KB). These tests pin the
 * parser, because every size check is only as honest as its denominator — a
 * parser that quietly finds nothing makes the whole budget pass vacuously.
 */
describe('indexEntries', () => {
  it('joins a bullet with its indented continuation lines', () => {
    const md = ['- **A**: one', '  two three', '- **B**: four', ''].join('\n');
    const entries = indexEntries(md);
    expect(entries.map((e) => e.name)).toEqual(['A', 'B']);
    expect(entries[0].chars).toBe('- **A**: one two three'.length);
  });

  it('does not charge doc links to the budget — an entry must never be taxed for citing sources', () => {
    // Measured the other way, the pressure on an over-cap entry was to drop a
    // correct second link. The links are the point of the index; prose is what
    // regrows, so only prose is capped.
    const one = '- **A**: body text here. → [x.md](docs/x.md)';
    const two = '- **A**: body text here. → [x.md](docs/x.md), [y.md](docs/y.md)';
    expect(indexEntries(one)[0].chars).toBe(indexEntries(two)[0].chars);
    expect(indexEntries(two)[0].chars).toBe('- **A**: body text here.'.length);
  });

  it('measures with whitespace collapsed, so re-wrapping cannot flip the verdict', () => {
    const wide = '- **A**: one two three four';
    const narrow = ['- **A**: one two', '  three four'].join('\n');
    expect(indexEntries(wide)[0].chars).toBe(indexEntries(narrow)[0].chars);
  });

  it('ends an entry at a blank line or an unindented line', () => {
    const md = ['- **A**: one', '', 'Prose that is not part of the entry.', '- **B**: two'].join(
      '\n',
    );
    expect(indexEntries(md).map((e) => e.name)).toEqual(['A', 'B']);
  });

  it('reports the line each entry starts on, so a failure is navigable', () => {
    const md = ['# Title', '', '- **A**: one', '- **B**: two'].join('\n');
    expect(indexEntries(md).map((e) => e.line)).toEqual([3, 4]);
  });

  it('does not swallow a nested sub-bullet into its parent', () => {
    // Four-space indentation is a nested list item, not a continuation.
    const md = ['- **A**: one', '  wrapped', '- **B**: two'].join('\n');
    expect(indexEntries(md)).toHaveLength(2);
  });
});

describe('the size budget', () => {
  const claudeMd = readFileSync(resolve(REPO_ROOT, 'CLAUDE.md'), 'utf8');
  const indexMd = readFileSync(resolve(REPO_ROOT, 'docs', 'index.md'), 'utf8');
  const slugs = indexSectionSlugs();
  const sectionText = (slug: string) =>
    readFileSync(resolve(REPO_ROOT, 'docs', 'index', `${slug}.md`), 'utf8');
  const sections = slugs.map((slug) => ({ slug, text: sectionText(slug) }));
  const allEntries = [indexMd, ...sections.map((s) => s.text)].flatMap(indexEntries);
  const indexBytes = [indexMd, ...sections.map((s) => s.text)].reduce(
    (n, t) => n + Buffer.byteLength(t, 'utf8'),
    0,
  );

  it('holds on the real files, with headroom', () => {
    // The denominator is asserted against the files that actually hold the
    // index, and against their SUM: per-file it would be meaningless, because a
    // small section legitimately holds 8 entries. CLAUDE.md keeps a handful of
    // Surfaces entries; pointing this there would pass vacuously.
    expect(allEntries.length).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_ENTRIES);
    for (const e of [...allEntries, ...indexEntries(claudeMd)]) {
      expect(e.chars, `L${e.line} ${e.name}`).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
    }
    expect(Buffer.byteLength(claudeMd, 'utf8')).toBeLessThanOrEqual(MAX_CLAUDE_MD_BYTES);
    for (const { slug, text } of sections) {
      expect(Buffer.byteLength(text, 'utf8'), slug).toBeLessThanOrEqual(MAX_INDEX_SECTION_BYTES);
    }
  });

  it('keeps CLAUDE.md far smaller than the index it points at — that is the whole point of #934', () => {
    // If these ever converge, the index has drifted back into the file that is
    // paid for on every request, and the relocation has quietly been undone.
    expect(Buffer.byteLength(claudeMd, 'utf8')).toBeLessThan(indexBytes / 2);
  });

  it('is not set flush against the current files — a cap that fires on the next honest addition gets raised reflexively', () => {
    expect(MAX_CLAUDE_MD_BYTES - Buffer.byteLength(claudeMd, 'utf8')).toBeGreaterThan(5_000);
    // Per SECTION now. A single total could not hold this: #1240 measured the
    // index growing ~1,040 bytes/day, which ate a 10,000-byte raise in 14 days.
    for (const { slug, text } of sections) {
      expect(MAX_INDEX_SECTION_BYTES - Buffer.byteLength(text, 'utf8'), slug).toBeGreaterThan(
        5_000,
      );
    }
    const max = Math.max(...allEntries.map((e) => e.chars));
    expect(MAX_ENTRY_CHARS - max).toBeGreaterThan(20);
  });

  it('keeps every section reachable from the contents table, both ways', () => {
    expect(sectionMismatches(indexMd, slugs)).toEqual([]);
    expect(slugs.length).toBeGreaterThan(1);
  });
});

describe('sectionMismatches', () => {
  const toc = (...slugs: string[]) => slugs.map((s) => `| [x](index/${s}.md) | scope |`).join('\n');

  it('passes when the table and the directory agree', () => {
    expect(sectionMismatches(toc('library', 'playback'), ['library', 'playback'])).toEqual([]);
  });

  // The silent one: the file is checked by every other arm of this gate, and no
  // reader ever opens it, because the table is the only route in.
  it('fails a section file the contents table never links', () => {
    const errors = sectionMismatches(toc('library'), ['library', 'orphan']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unreachable');
  });

  it('fails a contents row whose file does not exist', () => {
    const errors = sectionMismatches(toc('library', 'ghost'), ['library']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('does not exist');
  });
});

describe('links after the #934 relocation', () => {
  it('resolves a link against the linking file own directory, not the repo root', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-md-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'real.md'), '# real');

    // How docs/index.md writes it: relative, no docs/ prefix.
    expect(brokenDocLinks('[a](real.md)', root, 'docs')).toEqual([]);
    expect(brokenDocLinks('[a](ghost.md)', root, 'docs')).toEqual(['ghost.md']);
    // ...and the same target from CLAUDE.md, at the root.
    expect(brokenDocLinks('[a](docs/real.md)', root)).toEqual([]);

    rmSync(root, { recursive: true, force: true });
  });

  it('does not charge a relative .md link to the entry budget either', () => {
    // Regression: entryProse stripped only `docs/`-prefixed links, so the moment
    // the index moved inside docs/ and started writing `[x.md](x.md)`, entries
    // were charged for their own links again and the cap fired on a correct one.
    const rooted = '- **X**: a thing. \u2192 [web-ui.md](docs/web-ui.md)';
    const relative = '- **X**: a thing. \u2192 [web-ui.md](web-ui.md)';
    expect(entryProse(relative)).toBe(entryProse(rooted));
    expect(entryProse(relative)).toBe('- **X**: a thing.');
  });
});
