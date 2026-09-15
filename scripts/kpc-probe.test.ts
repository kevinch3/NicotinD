import { describe, expect, it } from 'bun:test';
import { dirname, join, resolve } from 'node:path';

/**
 * The probe's alerting state machine (`kpc-probe.sh decide`), exercised as a
 * truth table with no network.
 *
 * Worth gating rather than eyeballing: the failure modes of an alerter are
 * quiet ones. An alert that fires every minute trains you to ignore it; a
 * recovery that never fires leaves you believing something is still broken; and
 * an alert that blames the target when the *observer* is the broken half is the
 * exact mistake this whole incident started with.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const SCRIPT = join(repoRoot, 'scripts', 'kpc-probe.sh');

const THRESHOLD = 3;
const RENOTIFY = 30;

async function decide(o: {
  targetOk: boolean;
  controlOk?: boolean;
  fails: number;
  notified?: boolean;
  minsSince?: number;
}): Promise<string> {
  const proc = Bun.spawn(
    [
      'bash',
      SCRIPT,
      'decide',
      o.targetOk ? '1' : '0',
      (o.controlOk ?? true) ? '1' : '0',
      String(o.fails),
      o.notified ? '1' : '0',
      String(o.minsSince ?? 999999),
      String(THRESHOLD),
      String(RENOTIFY),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  expect(code).toBe(0);
  return out.trim();
}

describe('kpc-probe alerting state machine', () => {
  it('stays quiet while the target answers', async () => {
    expect(await decide({ targetOk: true, fails: 0 })).toBe('ok');
  });

  it('does not alert on a single blip — one failed probe is not an outage', async () => {
    expect(await decide({ targetOk: false, fails: 1 })).toBe('wait');
    expect(await decide({ targetOk: false, fails: 2 })).toBe('wait');
  });

  it('alerts exactly at the threshold', async () => {
    expect(await decide({ targetOk: false, fails: THRESHOLD })).toBe('alert');
  });

  it('alerts ONCE, not every minute, while the outage continues', async () => {
    // The 09-14 outage ran 222 minutes. Without this, that is 222 notifications
    // and a habit of ignoring them.
    for (const fails of [4, 10, 60, 222]) {
      expect(await decide({ targetOk: false, fails, notified: true, minsSince: 5 })).toBe('wait');
    }
  });

  it('re-notifies once the renotify window elapses, so a long outage is not forgotten', async () => {
    expect(await decide({ targetOk: false, fails: 40, notified: true, minsSince: RENOTIFY })).toBe(
      'renotify',
    );
    expect(
      await decide({ targetOk: false, fails: 40, notified: true, minsSince: RENOTIFY - 1 }),
    ).toBe('wait');
  });

  it('reports recovery only if it actually alerted', async () => {
    expect(await decide({ targetOk: true, fails: 9, notified: true })).toBe('recovered');
    // Blips that never alerted must not produce an "all clear" for a thing the
    // user was never told about.
    expect(await decide({ targetOk: true, fails: 2, notified: false })).toBe('ok');
  });

  it('blames the path, not the target, when its own control host is also unreachable', async () => {
    // THE lesson of this incident: unreachable-from-here is a property of the
    // path. A probe that cannot reach anything must not report "kpc is down".
    expect(await decide({ targetOk: false, controlOk: false, fails: 99 })).toBe('path-fault');
  });

  it('keeps blaming the path even mid-incident, rather than flipping to alert', async () => {
    expect(
      await decide({ targetOk: false, controlOk: false, fails: 99, notified: true, minsSince: 60 }),
    ).toBe('path-fault');
  });

  it('never emits an action the caller does not handle', async () => {
    const handled = new Set(['ok', 'recovered', 'path-fault', 'alert', 'renotify', 'wait']);
    // Sweep the corners of the input space; an unhandled action silently does
    // nothing in the case statement, which is the worst possible failure here.
    for (const targetOk of [true, false])
      for (const controlOk of [true, false])
        for (const fails of [0, 1, THRESHOLD, 500])
          for (const notified of [true, false])
            for (const minsSince of [0, RENOTIFY, 999999]) {
              const action = await decide({ targetOk, controlOk, fails, notified, minsSince });
              expect(handled).toContain(action);
            }
  });
});
