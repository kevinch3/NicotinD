/**
 * Pure rendering of gathered observations into the playground findings report
 * (markdown + JSON). No Playwright / fs here — the reporter (`reporter.ts`) owns
 * IO and calls these; these are unit-tested in CI.
 */
import {
  type Observation,
  type ObservationKind,
  type Severity,
  sortObservations,
  summarize,
} from './observe.js';

export interface ReportInput {
  generatedAt: string;
  /** baseURL the run targeted. */
  target: string;
  /** "live" when E2E_BASE_URL was set, else "managed" (degraded). */
  mode: 'live' | 'managed';
  observations: Observation[];
}

const SEVERITY_ICON: Record<Severity, string> = {
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  info: '⚪',
};

const KIND_LABEL: Record<ObservationKind, string> = {
  metric: 'metric',
  timing: 'timing',
  gap: 'gap',
  enhancement: 'enhancement',
  degraded: 'degraded',
  error: 'error',
};

export function renderJson(input: ReportInput): string {
  return JSON.stringify(
    {
      generatedAt: input.generatedAt,
      target: input.target,
      mode: input.mode,
      summary: summarize(input.observations),
      observations: sortObservations(input.observations),
    },
    null,
    2,
  );
}

export function renderMarkdown(input: ReportInput): string {
  const sum = summarize(input.observations);
  const out: string[] = [];

  out.push('# E2E Playground — Automated Feedback Report');
  out.push('');
  out.push(`**Generated:** ${input.generatedAt}  `);
  out.push(`**Target:** \`${input.target}\` (${input.mode})  `);
  out.push(`**Observations:** ${sum.total} across ${sum.flows.length} flow(s)`);
  out.push('');
  if (input.mode === 'managed') {
    out.push(
      '> ⚠️ Ran against the **managed** server (dead slskd/Lidarr). Acquisition flows are ' +
        'degraded — point `E2E_BASE_URL` at a live stack for full feedback.',
    );
    out.push('');
  }

  // Summary table.
  out.push('## Summary');
  out.push('');
  out.push('| Severity | Count | Kind | Count |');
  out.push('|----------|-------|------|-------|');
  const sevRows: Severity[] = ['high', 'medium', 'low', 'info'];
  const kindRows: ObservationKind[] = ['error', 'gap', 'enhancement', 'timing', 'degraded', 'metric'];
  const rows = Math.max(sevRows.length, kindRows.length);
  for (let i = 0; i < rows; i++) {
    const s = sevRows[i];
    const k = kindRows[i];
    const sevCell = s ? `${SEVERITY_ICON[s]} ${s}` : '';
    const sevCount = s ? String(sum.bySeverity[s] ?? 0) : '';
    const kindCell = k ? KIND_LABEL[k] : '';
    const kindCount = k ? String(sum.byKind[k] ?? 0) : '';
    out.push(`| ${sevCell} | ${sevCount} | ${kindCell} | ${kindCount} |`);
  }
  out.push('');

  // Top signals: high+medium gaps/enhancements/errors/timing.
  const signals = sortObservations(input.observations).filter(
    (o) => (o.severity === 'high' || o.severity === 'medium') && o.kind !== 'metric',
  );
  if (signals.length > 0) {
    out.push('## Top signals');
    out.push('');
    for (const o of signals) {
      out.push(`- ${SEVERITY_ICON[o.severity]} **[${o.flow}]** ${o.title}${fmtValue(o)}`);
      if (o.suggestion) out.push(`  - ↳ ${o.suggestion}`);
    }
    out.push('');
  }

  // Per-flow detail.
  for (const flow of sum.flows) {
    out.push(`## ${flow}`);
    out.push('');
    const items = sortObservations(input.observations.filter((o) => o.flow === flow));
    for (const o of items) {
      out.push(
        `- ${SEVERITY_ICON[o.severity]} \`${KIND_LABEL[o.kind]}\` **${o.title}**${fmtValue(o)}`,
      );
      if (o.detail) out.push(`  - ${o.detail}`);
      if (o.suggestion) out.push(`  - ↳ ${o.suggestion}`);
    }
    out.push('');
  }

  return out.join('\n');
}

function fmtValue(o: Observation): string {
  if (o.value === undefined || o.value === '') return '';
  return ` — ${o.value}${o.unit ? ` ${o.unit}` : ''}`;
}
