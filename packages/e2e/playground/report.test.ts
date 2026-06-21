import { describe, expect, it } from 'bun:test';
import type { Observation } from './observe';
import { renderJson, renderMarkdown, type ReportInput } from './report';

const obs = (o: Partial<Observation>): Observation => ({
  flow: 'song-acquisition (§F)',
  kind: 'metric',
  title: 't',
  severity: 'info',
  ...o,
});

const input = (observations: Observation[], mode: 'live' | 'managed' = 'live'): ReportInput => ({
  generatedAt: '2026-06-14T00:00:00.000Z',
  target: 'http://localhost:8585',
  mode,
  observations,
});

describe('renderMarkdown', () => {
  it('includes header, target, and observation count', () => {
    const md = renderMarkdown(input([obs({}), obs({ flow: 'catalog (§A)' })]));
    expect(md).toContain('# E2E Playground — Automated Feedback Report');
    expect(md).toContain('http://localhost:8585');
    expect(md).toContain('2 across 2 flow(s)');
  });

  it('warns when running in managed (degraded) mode', () => {
    expect(renderMarkdown(input([], 'managed'))).toContain('managed');
    expect(renderMarkdown(input([], 'live'))).not.toContain('⚠️ Ran against the **managed**');
  });

  it('surfaces high/medium non-metric items in Top signals', () => {
    const md = renderMarkdown(
      input([
        obs({ kind: 'gap', title: 'No song lane', severity: 'high', suggestion: 'add a lane' }),
        obs({ kind: 'metric', title: 'just a number', severity: 'high' }),
      ]),
    );
    expect(md).toContain('## Top signals');
    expect(md).toContain('No song lane');
    expect(md).toContain('↳ add a lane');
    // metrics never appear as a "signal" even when high.
    const signalsSection = md.slice(md.indexOf('## Top signals'), md.indexOf('## song-acquisition'));
    expect(signalsSection).not.toContain('just a number');
  });

  it('renders an Outcome matrix from outcome metrics', () => {
    const md = renderMarkdown(
      input([
        obs({ flow: 'playlists', title: 'Outcome', value: 'success', detail: 'created + deleted' }),
        obs({ flow: 'sharing', title: 'Outcome', value: 'degraded' }),
      ]),
    );
    expect(md).toContain('## Outcomes');
    expect(md).toContain('| playlists | ✅ success — created + deleted |');
    expect(md).toContain('| sharing | 🟡 degraded |');
  });

  it('renders a Health summary with captured errors', () => {
    const clean = renderMarkdown(input([obs({})]));
    expect(clean).toContain('## Health');
    expect(clean).toContain('✅ No runtime errors captured');

    const broken = renderMarkdown(
      input([obs({ flow: 'downloads', kind: 'error', title: 'Console error', detail: 'boom', severity: 'high' })]),
    );
    expect(broken).toContain('🔴 1 runtime error(s) captured');
    expect(broken).toContain('**[downloads]** Console error — boom');
  });

  it('groups observations under per-flow sections with values', () => {
    const md = renderMarkdown(
      input([obs({ flow: 'catalog (§A)', title: 'own albums', value: '2/10', unit: '(20%)' })]),
    );
    expect(md).toContain('## catalog (§A)');
    expect(md).toContain('**own albums** — 2/10 (20%)');
  });
});

describe('renderJson', () => {
  it('emits a parseable summary + sorted observations', () => {
    const parsed = JSON.parse(
      renderJson(input([obs({ kind: 'gap', severity: 'high' }), obs({ severity: 'low' })])),
    );
    expect(parsed.mode).toBe('live');
    expect(parsed.summary.total).toBe(2);
    expect(parsed.observations[0].severity).toBe('high'); // sorted
  });

  it('surfaces outcomes and errors as top-level arrays', () => {
    const parsed = JSON.parse(
      renderJson(
        input([
          obs({ flow: 'a', title: 'Outcome', value: 'failed' }),
          obs({ flow: 'a', kind: 'error', title: 'Console error', severity: 'high' }),
        ]),
      ),
    );
    expect(parsed.outcomes).toHaveLength(1);
    expect(parsed.outcomes[0]).toMatchObject({ flow: 'a', outcome: 'failed' });
    expect(parsed.errors).toHaveLength(1);
  });
});
