import { describe, expect, it } from 'bun:test';
import {
  livenessReport,
  probeRenderer,
  wedgeAnnotation,
  type ProbeTarget,
} from '../renderer-liveness';

function target(evaluate: () => Promise<unknown>, closed = false): ProbeTarget {
  return { isClosed: () => closed, evaluate: evaluate as ProbeTarget['evaluate'] };
}

describe('probeRenderer (#1185)', () => {
  it('reports alive when the renderer answers', async () => {
    expect(
      await probeRenderer(
        target(async () => 1),
        50,
      ),
    ).toBe('alive');
  });

  it('reports alive for a busy renderer that answers inside the budget', async () => {
    const slow = () => new Promise((r) => setTimeout(() => r(1), 20));
    expect(await probeRenderer(target(slow), 500)).toBe('alive');
  });

  it('reports wedged when the evaluate never settles', async () => {
    expect(
      await probeRenderer(
        target(() => new Promise(() => {})),
        30,
      ),
    ).toBe('wedged');
  });

  it('reports wedged when the evaluate rejects on an open page', async () => {
    expect(
      await probeRenderer(
        target(() => Promise.reject(new Error('crashed'))),
        50,
      ),
    ).toBe('wedged');
  });

  it('reports closed without evaluating on a closed page', async () => {
    let called = false;
    const verdict = await probeRenderer(
      target(async () => {
        called = true;
        return 1;
      }, true),
      50,
    );
    expect(verdict).toBe('closed');
    expect(called).toBe(false);
  });
});

describe('livenessReport', () => {
  it('names the verdict, the url and the #1185 signature for a wedge', () => {
    const report = livenessReport('wedged', 'http://x/settings', 3000);
    expect(report).toContain('renderer: wedged');
    expect(report).toContain('url: http://x/settings');
    expect(report).toContain('#1185');
  });

  it('says a live renderer rules the wedge out', () => {
    expect(livenessReport('alive', 'http://x/', 3000)).toContain('not a wedged renderer');
  });
});

describe('wedgeAnnotation', () => {
  it('is a GitHub warning naming the test and the page', () => {
    expect(
      wedgeAnnotation('settings › opens', 'http://x/settings', { GITHUB_ACTIONS: 'true' }),
    ).toBe('::warning title=Wedged renderer (#1185)::settings › opens at http://x/settings');
  });

  it('escapes what would end or corrupt the workflow command', () => {
    expect(wedgeAnnotation('50% done\nnext', 'http://x/', { GITHUB_ACTIONS: 'true' })).toBe(
      '::warning title=Wedged renderer (#1185)::50%25 done%0Anext at http://x/',
    );
  });

  it('is nothing outside GitHub Actions', () => {
    expect(wedgeAnnotation('t', 'http://x/', {})).toBeNull();
  });
});
