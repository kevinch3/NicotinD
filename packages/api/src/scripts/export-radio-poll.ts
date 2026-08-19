/**
 * Export radio evaluation polls into offline weight-tuning datasets.
 *
 *   bun run packages/api/src/scripts/export-radio-poll.ts [--poll <id|token>] [--out <dir>]
 *
 * Defaults to every CLOSED poll (an open poll is still collecting votes, so its
 * consensus is a moving target); `--poll` exports one poll regardless of state.
 * Each poll becomes one self-contained JSON (`radio-poll-<id>.json`): frozen
 * seed/candidate features, per-axis explanations, the weight set used, and the
 * per-candidate up/down tallies + majority consensus — everything needed to
 * replay `scoreSimilarity` against human judgments with no live library.
 * See docs/radio-eval-polls.md "Export & digestion".
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG. Dev tool — not run in CI; the DB is
 * opened read-only (same discipline as prod-probe.ts).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { expandHome } from '@nicotind/core';
import { getPollById, getPollByToken, type RadioPollRow } from '../services/radio-poll-store.js';
import { pollExportDataset } from '../services/radio-poll-export.js';

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

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const dataDir = loadDataDir();
  const db = new Database(join(dataDir, 'nicotind.db'), { readonly: true });
  const outDir = resolve(argValue('--out') ?? join(dataDir, 'radio-poll-export'));

  const pollArg = argValue('--poll');
  let polls: RadioPollRow[];
  if (pollArg) {
    const poll = getPollById(db, pollArg) ?? getPollByToken(db, pollArg);
    if (!poll) {
      console.error(`Poll not found: ${pollArg}`);
      process.exit(1);
    }
    polls = [poll];
  } else {
    polls = db
      .query<RadioPollRow, []>(
        'SELECT * FROM radio_polls WHERE closed_at IS NOT NULL ORDER BY created_at',
      )
      .all();
    if (polls.length === 0) {
      console.log('No closed polls to export (use --poll <id|token> for an open one).');
      db.close();
      return;
    }
  }

  mkdirSync(outDir, { recursive: true });
  for (const poll of polls) {
    const dataset = pollExportDataset(db, poll);
    const path = join(outDir, `radio-poll-${poll.id}.json`);
    writeFileSync(path, JSON.stringify(dataset, null, 2) + '\n');
    const graded = dataset.scenarios
      .flatMap((s) => s.candidates)
      .filter((c) => c.consensus !== null).length;
    console.log(
      `  ✓ ${path}  "${dataset.name}" — ${dataset.scenarios.length} scenario(s), ` +
        `${dataset.voteCount} vote(s) from ${dataset.raterCount} rater(s), ${graded} graded candidate(s)`,
    );
  }
  db.close();
}

main();
