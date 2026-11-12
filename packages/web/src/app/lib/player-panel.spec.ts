import { describe, it, expect } from 'vitest';
import {
  DISMISS_THRESHOLD_PX,
  LEGACY_ACTIVE_PANEL_KEY,
  LEGACY_QUEUE_EXTRA_KEY,
  PANEL_STORAGE_KEY,
  SNAP_COMMIT_MAX_PX,
  clampLift,
  effectiveSnap,
  gestureBaseLift,
  panelLayout,
  persistPanelState,
  resolvePullMode,
  restorePanelState,
  settle,
  snapCommitPx,
  transition,
  type PanelEvent,
  type PanelGeometry,
  type PanelSnap,
  type PanelState,
  type PanelStorage,
  type PullMode,
  type PullOrigin,
  type SettleResult,
} from './player-panel';
import { FLICK_PX_PER_MS } from './vertical-swipe';

// A tall phone: the commit distance is capped at 96 px.
const G: PanelGeometry = { fullLiftPx: 600, coverMaxPx: 320 };
// A short sheet: 35 % of the gap is under the cap.
const SHORT: PanelGeometry = { fullLiftPx: 200, coverMaxPx: 120 };
const FLICK = FLICK_PX_PER_MS;
const COMMIT = snapCommitPx(G.fullLiftPx);

describe('snapCommitPx', () => {
  it('is 35 % of the gap, capped at the mini bar threshold', () => {
    expect(snapCommitPx(600)).toBe(SNAP_COMMIT_MAX_PX);
    expect(snapCommitPx(200)).toBeCloseTo(70);
    expect(snapCommitPx(-5)).toBe(0);
  });
});

describe('settle (§2.3 drag-end rows)', () => {
  const snap = (s: PanelSnap): SettleResult => ({ kind: 'snap', snap: s });
  const dismiss: SettleResult = { kind: 'dismiss' };
  const rows: [string, PanelSnap, number, number, SettleResult][] = [
    // start, lift, velocity (px/ms, + up), expected
    ['rest: a pull past the commit distance opens full', 'rest', COMMIT, 0, snap('full')],
    ['rest: a pull just short of it stays', 'rest', COMMIT - 1, 0, snap('rest')],
    ['rest: a short up-flick opens full', 'rest', 10, FLICK, snap('full')],
    ['rest: a slow short pull stays', 'rest', 10, FLICK - 0.01, snap('rest')],
    ['rest: no movement stays', 'rest', 0, 0, snap('rest')],
    ['rest: a pull down past 120 px dismisses', 'rest', -DISMISS_THRESHOLD_PX, 0, dismiss],
    [
      'rest: a pull down short of 120 px stays',
      'rest',
      -(DISMISS_THRESHOLD_PX - 1),
      0,
      snap('rest'),
    ],
    ['rest: a short down-flick dismisses', 'rest', -10, -FLICK, dismiss],
    ['rest: a down-flick that ended moving up stays', 'rest', -10, FLICK, snap('rest')],
    [
      'full: a pull down past the commit distance collapses',
      'full',
      G.fullLiftPx - COMMIT,
      0,
      snap('rest'),
    ],
    ['full: a pull just short of it stays', 'full', G.fullLiftPx - COMMIT + 1, 0, snap('full')],
    ['full: a short down-flick collapses', 'full', G.fullLiftPx - 5, -FLICK, snap('rest')],
    ['full: an up-flick stays', 'full', G.fullLiftPx, FLICK, snap('full')],
  ];
  it.each(rows)('%s', (_name, start, lift, v, expected) => {
    expect(settle(start, lift, v, G)).toEqual(expected);
  });

  it('a hard fling down from full lands on rest, never a dismiss (one snap max)', () => {
    expect(settle('full', -2000, -10, G)).toEqual(snap('rest'));
  });

  it('a hard fling up from rest lands on full and no further', () => {
    expect(settle('rest', 5000, 10, G)).toEqual(snap('full'));
  });

  it('a cancel is the same rows with velocity 0', () => {
    // The release would have flicked; the cancel settles by distance only.
    expect(settle('rest', 10, FLICK, G)).toEqual(snap('full'));
    expect(settle('rest', 10, 0, G)).toEqual(snap('rest'));
    expect(settle('rest', -10, -FLICK, G)).toEqual(dismiss);
    expect(settle('rest', -10, 0, G)).toEqual(snap('rest'));
  });

  it('uses the geometry: 35 % of a short sheet commits', () => {
    expect(settle('rest', 70, 0, SHORT)).toEqual(snap('full'));
    expect(settle('rest', 69, 0, SHORT)).toEqual(snap('rest'));
  });
});

describe('clampLift (continuation, D2 A)', () => {
  it('from rest, a pull runs below 0 into a dismiss', () => {
    expect(clampLift('rest', -300, G)).toBe(-300);
  });
  it('from full, a collapse clamps at rest', () => {
    expect(clampLift('full', -300, G)).toBe(0);
  });
  it('never lifts past full', () => {
    expect(clampLift('rest', 9999, G)).toBe(G.fullLiftPx);
    expect(clampLift('full', 9999, G)).toBe(G.fullLiftPx);
  });
});

describe('gestureBaseLift (interrupted settle)', () => {
  it('starts from the snap when nothing animates', () => {
    expect(gestureBaseLift('full', null, G)).toBe(G.fullLiftPx);
    expect(gestureBaseLift('rest', null, G)).toBe(0);
  });
  it('starts from the rendered lift mid-flight, not the target', () => {
    expect(gestureBaseLift('full', 410, G)).toBe(410);
    expect(gestureBaseLift('rest', 150, G)).toBe(150);
  });
  it('a release just after catching it mid-flight settles by where it is', () => {
    const base = gestureBaseLift('full', 300, G);
    // Caught on its way up at 300 and let go untouched: 300 is past rest's commit.
    expect(settle('rest', base, 0, G)).toEqual({ kind: 'snap', snap: 'full' });
  });
});

describe('panelLayout (§2.2)', () => {
  it('rest: the cover at its max, nothing moved', () => {
    expect(panelLayout(0, G)).toEqual({
      coverMaxPx: 320,
      panelTranslatePx: 0,
      sheetOffsetPx: 0,
      stageCovered: 0,
    });
  });
  it('the first coverMaxPx of lift shrink the cover', () => {
    expect(panelLayout(120, G)).toMatchObject({ coverMaxPx: 200, panelTranslatePx: 0 });
    expect(panelLayout(320, G)).toMatchObject({ coverMaxPx: 0, panelTranslatePx: 0 });
  });
  it('the rest translate the panel over the stage', () => {
    expect(panelLayout(460, G)).toEqual({
      coverMaxPx: 0,
      panelTranslatePx: 140,
      sheetOffsetPx: 0,
      stageCovered: 0.5,
    });
    expect(panelLayout(600, G).stageCovered).toBe(1);
    expect(panelLayout(900, G).panelTranslatePx).toBe(280);
  });
  it('below rest the whole sheet follows the finger down', () => {
    expect(panelLayout(-80, G)).toEqual({
      coverMaxPx: 320,
      panelTranslatePx: 0,
      sheetOffsetPx: 80,
      stageCovered: 0,
    });
  });
  it('a full lift no taller than the cover covers the stage at once', () => {
    expect(panelLayout(100, { fullLiftPx: 100, coverMaxPx: 100 }).stageCovered).toBe(0);
    expect(panelLayout(100, { fullLiftPx: 100, coverMaxPx: 80 }).stageCovered).toBe(1);
  });
});

describe('resolvePullMode (§2.4)', () => {
  const rows: [PullOrigin, 'up' | 'down', PanelSnap, number, boolean, PullMode][] = [
    // origin, direction, snap, nested scrollTop, lg, mode
    ['panel', 'down', 'rest', 40, false, 'release'],
    ['panel', 'down', 'full', 40, false, 'release'],
    ['panel', 'up', 'full', 0, false, 'release'],
    ['panel', 'up', 'rest', 0, false, 'panel'],
    ['panel', 'up', 'rest', 40, false, 'panel'],
    ['panel', 'down', 'rest', 0, false, 'panel'],
    ['panel', 'down', 'full', 0, false, 'panel'],
    ['stage', 'up', 'rest', 0, false, 'panel'],
    ['stage', 'down', 'rest', 0, false, 'dismiss'],
    ['panel', 'up', 'rest', 0, true, 'release'],
    ['panel', 'down', 'full', 0, true, 'dismiss'],
    ['stage', 'down', 'rest', 0, true, 'dismiss'],
  ];
  it.each(rows)(
    '%s %s at %s (scrollTop %d, lg %s) → %s',
    (origin, direction, snap, top, lg, mode) => {
      expect(resolvePullMode({ origin, direction, snap, nestedScrollTop: top, lg })).toBe(mode);
    },
  );
});

describe('transition (§2.3 discrete rows, D4 A)', () => {
  const at = (snap: PanelSnap, tab = 'queue'): PanelState => ({ snap, tab });
  const rows: [string, PanelState, PanelEvent, PanelState, boolean][] = [
    [
      'the active tab at rest opens full',
      at('rest'),
      { type: 'tap-tab', tab: 'queue' },
      at('full'),
      true,
    ],
    [
      'the active tab at full collapses',
      at('full'),
      { type: 'tap-tab', tab: 'queue' },
      at('rest'),
      true,
    ],
    [
      'another tab at rest switches, same snap',
      at('rest'),
      { type: 'tap-tab', tab: 'lyrics' },
      at('rest', 'lyrics'),
      true,
    ],
    [
      'another tab at full switches, same snap',
      at('full'),
      { type: 'tap-tab', tab: 'lyrics' },
      at('full', 'lyrics'),
      true,
    ],
    ['the notch at rest opens full', at('rest'), { type: 'notch-activate' }, at('full'), true],
    ['the notch at full collapses', at('full'), { type: 'notch-activate' }, at('rest'), true],
    ['key-up opens full', at('rest'), { type: 'key-up' }, at('full'), true],
    ['key-up at full stays', at('full'), { type: 'key-up' }, at('full'), true],
    ['key-down collapses', at('full'), { type: 'key-down' }, at('rest'), true],
    ['key-down at rest stays, never dismisses', at('rest'), { type: 'key-down' }, at('rest'), true],
    ['back at full collapses and is consumed', at('full'), { type: 'back' }, at('rest'), true],
    ['back at rest is the sheet’s to close', at('rest'), { type: 'back' }, at('rest'), false],
  ];
  it.each(rows)('%s', (_name, from, event, to, consumed) => {
    expect(transition(from, event)).toEqual({ state: to, consumed });
  });

  it('karaoke is the Lyrics tab at full (D5)', () => {
    const lyricsRest = at('rest', 'lyrics');
    expect(transition(lyricsRest, { type: 'tap-tab', tab: 'lyrics' }).state).toEqual(
      at('full', 'lyrics'),
    );
  });
});

describe('effectiveSnap (§5, lg)', () => {
  it('full shows beside the side column only for a tab that allows it', () => {
    expect(effectiveSnap(at2('full'), { lg: true, fullAtLg: false })).toBe('rest');
    expect(effectiveSnap(at2('full'), { lg: true, fullAtLg: true })).toBe('full');
    expect(effectiveSnap(at2('full'), { lg: false, fullAtLg: false })).toBe('full');
  });
  function at2(snap: PanelSnap): PanelState {
    return { snap, tab: 'queue' };
  }
});

describe('restorePanelState (§8)', () => {
  const TABS = ['queue', 'lyrics'] as const;
  function store(init: Record<string, string> = {}) {
    const data = new Map(Object.entries(init));
    const log: string[] = [];
    const s: PanelStorage & { data: Map<string, string>; log: string[] } = {
      data,
      log,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        log.push(`set ${k}`);
        data.set(k, v);
      },
      removeItem: (k) => {
        log.push(`remove ${k}`);
        data.delete(k);
      },
    };
    return s;
  }
  const panel = (v: unknown) => ({ [PANEL_STORAGE_KEY]: JSON.stringify(v) });

  it('uses a valid stored state', () => {
    expect(restorePanelState(store(panel({ v: 1, tab: 'lyrics', snap: 'full' })), TABS)).toEqual({
      tab: 'lyrics',
      snap: 'full',
    });
  });

  it('falls back to the first registered tab for an unknown one, keeping the snap', () => {
    expect(restorePanelState(store(panel({ v: 1, tab: 'gone', snap: 'full' })), TABS)).toEqual({
      tab: 'queue',
      snap: 'full',
    });
  });

  it('reads an unknown snap (an old hidden) as rest', () => {
    expect(restorePanelState(store(panel({ v: 1, tab: 'queue', snap: 'hidden' })), TABS)).toEqual({
      tab: 'queue',
      snap: 'rest',
    });
  });

  it.each([
    ['malformed JSON', { [PANEL_STORAGE_KEY]: '{nope' }],
    ['an unknown version', panel({ v: 2, tab: 'lyrics', snap: 'full' })],
  ])('falls through to the legacy keys on %s', (_name, init) => {
    const s = store({ ...init, [LEGACY_ACTIVE_PANEL_KEY]: 'lyrics' });
    expect(restorePanelState(s, TABS)).toEqual({ tab: 'lyrics', snap: 'rest' });
  });

  it.each([
    ['lyrics', 'lyrics'],
    ['queue', 'queue'],
    ['anything', 'queue'],
  ])('maps legacy active panel %s to tab %s', (legacy, tab) => {
    expect(restorePanelState(store({ [LEGACY_ACTIVE_PANEL_KEY]: legacy }), TABS)).toEqual({
      tab,
      snap: 'rest',
    });
  });

  it('maps any legacy cover-shrink size to rest, even the max', () => {
    expect(restorePanelState(store({ [LEGACY_QUEUE_EXTRA_KEY]: '320' }), TABS)).toEqual({
      tab: 'queue',
      snap: 'rest',
    });
  });

  it('writes the new key, then removes both legacy keys, in that order', () => {
    const s = store({ [LEGACY_ACTIVE_PANEL_KEY]: 'lyrics', [LEGACY_QUEUE_EXTRA_KEY]: '200' });
    restorePanelState(s, TABS);
    expect(s.log).toEqual([
      `set ${PANEL_STORAGE_KEY}`,
      `remove ${LEGACY_ACTIVE_PANEL_KEY}`,
      `remove ${LEGACY_QUEUE_EXTRA_KEY}`,
    ]);
    expect(JSON.parse(s.data.get(PANEL_STORAGE_KEY)!)).toEqual({
      v: 1,
      tab: 'lyrics',
      snap: 'rest',
    });
  });

  it('keeps the legacy keys readable when the new write fails', () => {
    const s = store({ [LEGACY_ACTIVE_PANEL_KEY]: 'lyrics' });
    s.setItem = () => {
      throw new Error('quota');
    };
    expect(restorePanelState(s, TABS)).toEqual({ tab: 'lyrics', snap: 'rest' });
    expect(s.data.get(LEGACY_ACTIVE_PANEL_KEY)).toBe('lyrics');
  });

  it('defaults to the queue at rest and writes nothing when storage is empty', () => {
    const s = store();
    expect(restorePanelState(s, TABS)).toEqual({ tab: 'queue', snap: 'rest' });
    expect(s.log).toEqual([]);
  });

  it('swallows a storage that throws on read', () => {
    const s: PanelStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(restorePanelState(s, TABS)).toEqual({ tab: 'queue', snap: 'rest' });
  });

  it('round-trips through persistPanelState', () => {
    const s = store();
    persistPanelState(s, { tab: 'lyrics', snap: 'full' });
    expect(restorePanelState(s, TABS)).toEqual({ tab: 'lyrics', snap: 'full' });
  });
});
