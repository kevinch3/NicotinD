/**
 * Measure similarity weight sets against the human radio-poll votes.
 *
 *   bun run packages/api/src/scripts/eval-radio-poll.ts \
 *     [--poll <id|token>] [--weights axis=n[,axis=n...]]
 *
 * For every poll (or one via --poll) this replays the frozen scenarios through
 * `explainSimilarity` (see services/radio-poll-eval.ts for exactly what is
 * recomputed vs frozen) and reports the within-scenario pairwise AUC of the
 * CURRENT DEFAULT_WEIGHTS — and, with --weights, of the overridden set side by
 * side. Results are grouped by `formula_version`: votes graded under different
 * formulas are never pooled into one number.
 *
 * Off-policy caveat: a poll only graded the top-K its *generating* formula
 * served, so an AUC validates ordering among those candidates, not pool
 * selection. Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG. Dev tool — not run in
 * CI; the DB is opened read-only (same discipline as prod-probe.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { expandHome } from '@nicotind/core';
import { DEFAULT_WEIGHTS, parseWeightOverrides } from '../services/radio.service.js';
import { getPollById, getPollByToken, type RadioPollRow } from '../services/radio-poll-store.js';
import { pollExportDataset, type RadioPollExportDataset } from '../services/radio-poll-export.js';
import {
  agreementAuc,
  evaluatePollAgreement,
  pooledTally,
  type PollAgreement,
} from '../services/radio-poll-eval.js';

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

const fmt = (auc: number | null): string => (auc === null ? '  -  ' : auc.toFixed(3));

function main(): void {
  const dataDir = loadDataDir();
  const db = new Database(join(dataDir, 'nicotind.db'), { readonly: true });

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
    polls = db.query<RadioPollRow, []>('SELECT * FROM radio_polls ORDER BY created_at').all();
  }
  if (polls.length === 0) {
    console.log('No polls to evaluate.');
    db.close();
    return;
  }

  const override = argValue('--weights') ? parseWeightOverrides(argValue('--weights')) : null;

  const datasets = new Map<RadioPollRow, RadioPollExportDataset>(
    polls.map((p) => [p, pollExportDataset(db, p)]),
  );
  db.close();

  const byFormula = new Map<string, Array<{ poll: RadioPollRow; ds: RadioPollExportDataset }>>();
  for (const [poll, ds] of datasets) {
    const group = byFormula.get(ds.formulaVersion) ?? [];
    group.push({ poll, ds });
    byFormula.set(ds.formulaVersion, group);
  }

  console.log(
    `Agreement of weight sets with the human poll votes (within-scenario pairwise AUC;` +
      ` 0.5 = random). Off-policy: each poll only graded the top-K its generating formula served.\n`,
  );
  for (const [formula, group] of [...byFormula.entries()].sort()) {
    console.log(`Formula v${formula} — ${group.length} poll(s):`);
    const base: PollAgreement[] = [];
    const over: PollAgreement[] = [];
    for (const { poll, ds } of group) {
      const b = evaluatePollAgreement(ds, DEFAULT_WEIGHTS);
      base.push(b);
      const state = poll.closed_at ? 'closed' : 'open';
      let line =
        `  "${ds.name}" [${state}]  current=${fmt(b.auc)}` +
        ` (${b.tally.pairs} pairs, ${b.gradedCandidates} graded, ${b.scenarioCount} scenarios)`;
      if (override) {
        const o = evaluatePollAgreement(ds, override);
        over.push(o);
        line += `  override=${fmt(o.auc)}`;
      }
      console.log(line);
    }
    const pooledBase = pooledTally(base);
    let pooledLine = `  pooled: current=${fmt(agreementAuc(pooledBase))} over ${pooledBase.pairs} pairs`;
    if (override) {
      const pooledOver = pooledTally(over);
      pooledLine += `  override=${fmt(agreementAuc(pooledOver))}`;
    }
    console.log(pooledLine + '\n');
  }
  if (override) {
    console.log(`Override spec: ${argValue('--weights')}`);
  }
}

main();
