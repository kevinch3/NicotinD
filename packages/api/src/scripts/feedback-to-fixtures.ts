/**
 * Export graded generation-feedback into replayable TDD fixtures.
 *
 *   bun run packages/api/src/scripts/feedback-to-fixtures.ts
 *
 * Reads every GRADED `hunt-match` row from `generation_feedback`, distills each
 * into a `HuntMatchFixture` (canonical tracklist + raw slskd responses + the
 * human-correct folder) via the pure `huntFixtureFromRecord`, and writes one JSON
 * per row to `packages/slskd-addon/src/services/__fixtures__/hunt-match/<id>.json`
 * (the corpus moved with the hunt engine — addon protocol phase 1, #488).
 *
 * The committed fixtures are the golden corpus that `album-hunter.replay.test.ts`
 * loads to assert the recognizer still ranks the human-correct folder #1 — the
 * red/green loop for the "smart linking" recognizer work. See docs/generation-feedback.md.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG. Dev tool — not run in CI.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { listFeedback, huntFixtureFromRecord } from '../services/generation-feedback.js';
import { expandHome } from '@nicotind/core';

export const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../slskd-addon/src/services/__fixtures__/hunt-match',
);

function loadDataDir(): string {
  let fileConfig: Record<string, unknown> = {};
  try {
    const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  return expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
}

function main(): void {
  const dataDir = loadDataDir();
  const db = new Database(join(dataDir, 'nicotind.db'), { readonly: true });

  const graded = listFeedback(db, { resourceType: 'hunt-match', graded: true, limit: 1000 });
  mkdirSync(FIXTURE_DIR, { recursive: true });

  let written = 0;
  for (const record of graded) {
    const fixture = huntFixtureFromRecord(record);
    if (!fixture) continue;
    const path = join(FIXTURE_DIR, `${record.id}.json`);
    writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
    written++;
    console.log(
      `  ✓ ${record.id}.json  [${fixture.meta.verdict}] ${fixture.meta.artistName} — ${fixture.meta.albumTitle}`,
    );
  }

  console.log(`\nWrote ${written} hunt-match fixture(s) to ${FIXTURE_DIR}`);
  db.close();
}

main();
