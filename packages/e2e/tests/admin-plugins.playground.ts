import { test, expect } from '../playground/fixtures';
import { appeared } from '../playground/screens-ui';

/**
 * Admin / plugins feedback flow — READ-ONLY by default (toggling a plugin changes
 * the compliance posture, so it's gated behind PLAYGROUND_PLUGIN_TOGGLE=<id> and
 * reverted in teardown). Visits /settings/plugins and /admin, reads plugin
 * enable-state + system status, and records console health + friction.
 * See docs/testing-routines.md.
 */
const TOGGLE_ID = process.env.PLAYGROUND_PLUGIN_TOGGLE;

interface PluginRow {
  id: string;
  enabled?: boolean;
}

test('admin-plugins', async ({ page, obs, apiToken }) => {
  const j = obs.journey();

  // 1. Plugins page renders (navigate first so the token is readable).
  await obs.time('open /settings/plugins', async () => {
    await page.goto('/settings/plugins');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
  j.step('open /settings/plugins');
  const token = await apiToken();
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  if (!(await appeared(page.locator('main'), 6000))) j.fallback('plugins page slow/blank');

  // 2. Read plugin states + system status via API (what the admin actually sees).
  const pluginsRes = await page.request.get('/api/plugins', { headers: auth });
  const plugins = pluginsRes.ok()
    ? (((await pluginsRes.json()) as { plugins?: PluginRow[] }).plugins ?? [])
    : [];
  const enabled = plugins.filter((p) => p.enabled).map((p) => p.id);
  obs.record({
    kind: 'metric',
    title: 'Plugins enabled',
    value: enabled.length,
    unit: 'count',
    severity: 'info',
    detail: enabled.join(', ') || 'none (default-off)',
  });

  await page.goto('/admin');
  j.step('open /admin');
  const statusRes = await page.request.get('/api/system/status', { headers: auth });
  if (statusRes.ok()) {
    const status = (await statusRes.json()) as { slskd?: { configured?: boolean; healthy?: boolean } };
    obs.record({
      kind: 'metric',
      title: 'slskd configured/healthy',
      value: `${status.slskd?.configured ? 'configured' : 'no'}/${status.slskd?.healthy ? 'healthy' : 'down'}`,
      severity: 'info',
    });
  }

  // 3. Optional gated toggle: flip a plugin and revert it. Off by default.
  if (TOGGLE_ID) {
    const before = plugins.find((p) => p.id === TOGGLE_ID)?.enabled ?? false;
    const action = before ? 'disable' : 'enable';
    try {
      const res = await page.request.post(`/api/plugins/${TOGGLE_ID}/${action}`, { headers: auth });
      j.step(`${action} ${TOGGLE_ID}`);
      if (res.status() === 412) {
        obs.record({
          kind: 'gap',
          title: `Enabling ${TOGGLE_ID} requires consent (412)`,
          severity: 'info',
          suggestion: 'Consent-gated plugin — toggle from the UI to accept the disclaimer.',
        });
      } else if (!res.ok()) {
        obs.record({
          kind: 'error',
          title: `Plugin ${action} failed`,
          detail: `status ${res.status()}`,
          severity: 'high',
        });
      }
    } finally {
      // Always restore the original state.
      await page.request.post(`/api/plugins/${TOGGLE_ID}/${before ? 'enable' : 'disable'}`, {
        headers: auth,
      });
    }
  }

  obs.outcome(pluginsRes.ok() ? 'success' : 'degraded', `${plugins.length} plugin(s)`);
  expect(true).toBe(true);
});
