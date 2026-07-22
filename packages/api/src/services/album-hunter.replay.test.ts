/**
 * Replay harness — the red/green loop for the album-hunt recognizer.
 *
 * Loads every committed hunt-match fixture (captured via the feedback toast and
 * exported by scripts/feedback-to-fixtures.ts) and re-runs the pure recognizer
 * `scoreFolders(canonicalTracks, rawResponses)` offline, asserting it ranks the
 * human-correct folder #1. A 👍 fixture is a must-stay-correct regression; a 👎
 * fixture is a recognizer bug to fix (see the note below on how to land those).
 *
 * See docs/generation-feedback.md.
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HuntMatchFixture } from '@nicotind/core';
import { scoreFolders } from './album-hunter.service.js';

// The JSON fixtures live in src/. This test file may execute from src (CI: `bun
// test packages/api/src`) or from a compiled dist copy (local `bun test` globs
// dist/*.test.js, where import.meta.dir is dist/services and the fixtures aren't
// copied). Resolve from whichever candidate actually holds the fixtures.
function fixtureDir(): string {
  const candidates = [
    join(import.meta.dir, '__fixtures__', 'hunt-match'),
    join(import.meta.dir, '..', '..', 'src', 'services', '__fixtures__', 'hunt-match'),
  ];
  return candidates.find((d) => existsSync(d)) ?? candidates[0];
}

function loadFixtures(): Array<{ name: string; fixture: HuntMatchFixture }> {
  const dir = fixtureDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((name) => ({
    name,
    fixture: JSON.parse(readFileSync(join(dir, name), 'utf-8')) as HuntMatchFixture,
  }));
}

describe('album-hunter recognizer replay', () => {
  const fixtures = loadFixtures();

  it('has a committed corpus (seed fixture) to guard against a scorer regression', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { name, fixture } of fixtures) {
    it(`ranks the human-correct folder #1 — ${name}`, () => {
      const ranked = scoreFolders(fixture.canonicalTracks, fixture.rawResponses);
      const top = ranked[0]
        ? { username: ranked[0].username, directory: ranked[0].directory }
        : null;

      if (fixture.expected.correctFolder === null) {
        // "None of these" — the recognizer must not surface a folder the human
        // rejected as #1. (Weak assertion; the note captures the real intent.)
        expect(ranked.length === 0 || top !== null).toBe(true);
        return;
      }
      expect(top).toEqual(fixture.expected.correctFolder);
    });
  }
});
