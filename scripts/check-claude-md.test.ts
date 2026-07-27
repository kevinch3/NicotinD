import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCheckableIdentifier, brokenDocLinks } from './check-claude-md.js';

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
    // `oauth` is documented as "proposed — not yet implemented"; castv2/bonjour
    // are npm packages, not repo symbols.
    expect(isCheckableIdentifier('oauth')).toBe(false);
    expect(isCheckableIdentifier('castv2')).toBe(false);
    expect(isCheckableIdentifier('dataGroups')).toBe(false);
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
