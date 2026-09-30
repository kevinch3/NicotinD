import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(['bash', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out.trim();
}

// Default knobs, as the script ships them (docs/host-monitoring.md derives each).
const loadBreach = (notified: boolean, l1: number, l5: number) =>
  run(['load-breach', notified ? '1' : '0', String(l1), String(l5), '30', '20', '12']);
const blocksBreach = (...ms: number[]) =>
  run(['blocks-breach', '10000', '5000', '3', ...ms.map(String)]);

describe('load precursor policy', () => {
  it('stays quiet at the highest load kpc has reached on a clean day', async () => {
    // 11.49: max of ~1,150 sar samples over 8 clean days before 09-14.
    // 9.78 / 9.23: max 1-/5-min of 1,204 samples 09-21..09-30, which include
    // the full-library Opus transcode — the heaviest legitimate work it has run.
    expect(await loadBreach(false, 11.49, 9.23)).toBe('clear');
    expect(await loadBreach(false, 9.78, 9.38)).toBe('clear');
  });

  it('trips on the 09-14 precursor, 1-min load 191.09', async () => {
    expect(await loadBreach(false, 191.09, 40)).toBe('breach');
  });

  it('keeps tripping on the 5-min average after the 1-min one has decayed', async () => {
    // A one-minute storm: the 1-min average falls ~e-fold a minute, the 5-min
    // average holds, so a probe that missed the peak minute still catches it.
    expect(await loadBreach(false, 26, 21)).toBe('breach');
  });

  it('has hysteresis: an alerted spike clears only under the clear level', async () => {
    expect(await loadBreach(true, 8, 15)).toBe('breach'); // would not trip anew...
    expect(await loadBreach(false, 8, 15)).toBe('clear'); // ...but is not over yet
    expect(await loadBreach(true, 8, 11.9)).toBe('clear');
  });
});

describe('event-loop block policy', () => {
  it('does not page on a boot — two blocks of ~1.5 s', async () => {
    // Every recorded deploy on prod: 10:31:58/10:32:00 (1531/1704 ms),
    // 15:31:41/43 (1424/1700 ms), 14:31:07/09 (1588/1727 ms).
    expect(await blocksBreach(1704, 1531)).toBe('clear 0 1704');
  });

  it('does not page on the busiest normal 15 minutes recorded', async () => {
    // 2026-09-29 11:12–11:18Z, an MCP curation session: 4 blocks, max 2256 ms.
    expect(await blocksBreach(1866, 2256, 1415, 1348)).toBe('clear 0 2256');
    // The highest single block recorded (midnight jobs, 09-30 00:01Z).
    expect(await blocksBreach(2898)).toBe('clear 0 2898');
  });

  it('pages on one block long enough to time out a probe', async () => {
    expect(await blocksBreach(10000)).toBe('breach 1 10000');
    expect(await blocksBreach(9999)).toBe('clear 1 9999');
  });

  it('pages on repeated multi-second blocks', async () => {
    expect(await blocksBreach(5000, 6000, 5100)).toBe('breach 3 6000');
    expect(await blocksBreach(5000, 6000, 4999)).toBe('clear 2 6000');
  });

  it('pages on nothing when there are no blocks, and ignores junk', async () => {
    expect(await blocksBreach()).toBe('clear 0 0');
    expect(await run(['blocks-breach', '10000', '5000', '3', 'x', '1.5'])).toBe('clear 0 0');
  });
});

/**
 * The whole script, end to end, with `curl` replaced on PATH by a fake that
 * serves kpc's health, its signals and a Home Assistant that records every
 * notification. No network.
 */
describe('kpc-probe end to end', () => {
  const FAKE_CURL = `#!/usr/bin/env bash
url=""; body=""; prev=""
for a in "$@"; do
  case "$a" in http*) url=$a ;; esac
  [ "$prev" = "-d" ] && body=$a
  prev=$a
done
case "$url" in
  */api/services/notify/*) printf '%s\\n' "$body" >>"$FAKE_DIR/notified"; exit 0 ;;
  */signals) [ -f "$FAKE_DIR/signals" ] && { cat "$FAKE_DIR/signals"; exit 0; }; exit 22 ;;
  */api/health) [ -f "$FAKE_DIR/target_up" ] && exit 0; exit 7 ;;
  *) [ -f "$FAKE_DIR/control_up" ] && exit 0; exit 7 ;;
esac
`;

  function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'kpc-probe-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
    writeFileSync(join(dir, 'target_up'), '');
    writeFileSync(join(dir, 'control_up'), '');
    const state = join(dir, 'state');
    const h = {
      dir,
      state,
      signals(load: number[], blockedMs: number[] | null) {
        writeFileSync(
          join(dir, 'signals'),
          JSON.stringify({ ok: true, load, cpus: 8, loopBlocks: { windowMs: 900000, blockedMs } }),
        );
      },
      noSignals: () => rmSync(join(dir, 'signals'), { force: true }),
      down: () => rmSync(join(dir, 'target_up'), { force: true }),
      async probe(env: Record<string, string> = {}) {
        const proc = Bun.spawn(['bash', SCRIPT], {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: dir,
            FAKE_DIR: dir,
            KPC_PROBE_ENV: join(dir, 'no-such-env'),
            KPC_STATE_DIR: state,
            HA_TOKEN: 'test-token',
            HA_NOTIFY_SERVICE: 'notify',
            ...env,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const err = await new Response(proc.stderr).text();
        expect(err).toBe('');
        expect(await proc.exited).toBe(0);
      },
      notified: (): string[] =>
        existsSync(join(dir, 'notified'))
          ? readFileSync(join(dir, 'notified'), 'utf8')
              .trim()
              .split('\n')
              .map((l) => (JSON.parse(l) as { title: string }).title)
          : [],
      log: () => readFileSync(join(state, 'probe.log'), 'utf8'),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
    return h;
  }

  it('pages once on a load spike, holds through the decay, and clears below the clear level', async () => {
    const h = harness();
    try {
      h.signals([0.6, 0.5, 0.5], []);
      await h.probe();
      expect(h.notified()).toEqual([]);
      expect(h.log()).toContain('ok (0s) load=0.6/0.5/0.5 blocks15m=[]');

      h.signals([191.09, 40, 10], []);
      await h.probe();
      expect(h.notified()).toEqual(['kpc load spike']);

      h.signals([26, 21, 10], []);
      await h.probe();
      h.signals([8, 15, 10], []); // under the trigger, over the clear level
      await h.probe();
      expect(h.notified()).toEqual(['kpc load spike']);

      h.signals([3, 9, 8], []);
      await h.probe();
      expect(h.notified()).toEqual(['kpc load spike', 'kpc load back to normal']);
      expect(h.log()).toContain('NOTIFIED: kpc load spike');
    } finally {
      h.cleanup();
    }
  });

  it('pages on stalls but not on a boot, and clears when the window empties', async () => {
    const h = harness();
    try {
      h.signals([1, 1, 1], [1704, 1531]);
      await h.probe();
      expect(h.notified()).toEqual([]);

      h.signals([1, 1, 1], [12000, 1704]);
      await h.probe();
      await h.probe();
      expect(h.notified()).toEqual(['kpc API stalling']);

      h.signals([1, 1, 1], []);
      await h.probe();
      expect(h.notified()).toEqual(['kpc API stalling', 'kpc API stalls cleared']);
    } finally {
      h.cleanup();
    }
  });

  it('leaves a check alone when its reading is unknown, rather than calling it clear', async () => {
    const h = harness();
    try {
      h.signals([1, 1, 1], [12000]);
      await h.probe();
      expect(h.notified()).toEqual(['kpc API stalling']);
      h.signals([1, 1, 1], null); // the API could not read its table
      await h.probe();
      h.noSignals(); // an API too old to serve /signals
      await h.probe();
      expect(h.notified()).toEqual(['kpc API stalling']);
      expect(h.log()).toContain('blocks15m=?');
      expect(h.log()).toContain('signals=unavailable');
    } finally {
      h.cleanup();
    }
  });

  it('still alerts on reachability, and reads no signals from a host it cannot reach', async () => {
    const h = harness();
    try {
      h.signals([191, 50, 10], [20000]);
      h.down();
      for (let i = 0; i < 3; i++) await h.probe();
      expect(h.notified()).toEqual(['kpc unreachable']);
      expect(existsSync(join(h.state, 'state.load'))).toBe(false);
      expect(readFileSync(join(h.state, 'state'), 'utf8').split(' ').slice(0, 2)).toEqual([
        '3',
        '1',
      ]);
    } finally {
      h.cleanup();
    }
  });

  it('test-fires every precursor alert with forced thresholds, then recovers on the defaults', async () => {
    // The documented install check: see NOTIFIED once without waiting for an incident.
    const h = harness();
    try {
      h.signals([0.5, 0.5, 0.5], []);
      const test = { KPC_TITLE_PREFIX: '[TEST] ' };
      await h.probe({ ...test, KPC_LOAD1_TRIGGER: '0', KPC_BLOCK_MIN_COUNT: '0' });
      expect(h.notified()).toEqual(['[TEST] kpc load spike', '[TEST] kpc API stalling']);
      await h.probe(test);
      expect(h.notified()).toEqual([
        '[TEST] kpc load spike',
        '[TEST] kpc API stalling',
        '[TEST] kpc load back to normal',
        '[TEST] kpc API stalls cleared',
      ]);
    } finally {
      h.cleanup();
    }
  });
});
