import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { mountWebUiMissing, webUiBuilt } from './web-dist-missing.js';

/**
 * #1732: from a source checkout, `bun run src/main.ts` without `bun run build`
 * served a bare 404 at `/` and logged nothing, so a self-hoster had no way to
 * know the web UI simply was not built.
 */
describe('a missing web UI build', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'nicotind-dist-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('is detected by the missing index.html, not just a missing folder', () => {
    const empty = tmp();
    expect(webUiBuilt(join(empty, 'nope'))).toBe(false);
    expect(webUiBuilt(empty)).toBe(false);
    writeFileSync(join(empty, 'index.html'), '<!doctype html>');
    expect(webUiBuilt(empty)).toBe(true);
  });

  it('warns once with the fix, and answers / with a page that says it', async () => {
    const warn = mock((..._a: unknown[]) => {});
    const app = new Hono();
    mountWebUiMissing(app, '/srv/nicotind/packages/web/dist', { warn });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toContain('bun run build');

    const res = await app.request('/');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('bun run build');
  });

  it('leaves /api alone', async () => {
    const app = new Hono();
    mountWebUiMissing(app, '/x', { warn: () => {} });
    app.get('/api/health', (c) => c.text('ok'));
    expect(await (await app.request('/api/health')).text()).toBe('ok');
  });
});
