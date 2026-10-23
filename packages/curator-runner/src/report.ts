import type { RunReport } from './run.js';

const STOP_TEXT: Record<RunReport['stop'], string> = {
  'worklist-exhausted': 'every eligible album was tried (the rest are in cooldown)',
  'targets-met': 'the configured targets were reached',
  'budget-exhausted': "the token's daily write budget ran out",
  'max-clusters': 'CURATOR_MAX_CLUSTERS was reached',
  'time-limit': 'CURATOR_MAX_MINUTES was reached',
  'ingest-in-progress': 'an ingest is still landing songs, so nothing was touched',
  'model-unavailable': 'the model endpoint failed repeatedly',
};

/**
 * The run as a pass record, in the shape of docs/measurements/curation-pass-*.md
 * (baseline, then actions, then final, then delta), so a scheduled run leaves
 * the same trail a manual pass does.
 */
export function renderReport(r: RunReport): string {
  const date = new Date(r.startedAt).toISOString().slice(0, 16).replace('T', ' ');
  const minutes = ((r.finishedAt - r.startedAt) / 60_000).toFixed(1);
  const delta = (a: number, b: number) =>
    b - a === 0 ? '0' : `${b - a > 0 ? '+' : '−'}${Math.abs(b - a)}`;
  const count = (k: string) => r.outcomes.filter((o) => o.result === k).length;
  const lines = [
    `# Curator run — ${date} UTC${r.dryRun ? ' (dry run)' : ''}`,
    '',
    `Model \`${r.model}\`, mode \`${r.apply}\`, ${r.iterations} iteration(s), ${minutes} min.`,
    `Stopped because ${STOP_TEXT[r.stop]}.`,
    '',
    '| Metric | Before | After | Delta |',
    '| --- | --- | --- | --- |',
    `| genres.lowInformation | ${r.before.lowInformation} | ${r.after.lowInformation} | ${delta(r.before.lowInformation, r.after.lowInformation)} |`,
    `| genres.missing | ${r.before.missing} | ${r.after.missing} | ${delta(r.before.missing, r.after.missing)} |`,
    '',
    `Albums: ${count('applied')} applied, ${count('proposed')} proposed as cards, ${count('skipped')} left untagged, ${count('dry-run')} dry-run, ${count('refused')} refused, ${count('error')} errors.`,
  ];
  if (r.outcomes.length > 0) {
    lines.push('', '| Album | Songs | Result | Detail |', '| --- | --- | --- | --- |');
    for (const o of r.outcomes) {
      const detail =
        o.result === 'applied'
          ? `${o.decision?.kind === 'apply' ? o.decision.genre : ''}: ${o.written ?? 0} written, ${o.verified ?? 0} read back${o.note ? `; ${o.note}` : ''}`
          : (o.note ?? '');
      const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 160);
      lines.push(
        `| ${cell(`${o.albumArtist} — ${o.album}`)} | ${o.candidates} | ${o.result} | ${cell(detail)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
