import { describe, expect, test } from 'bun:test';
import {
  appWebview,
  hapticCalls,
  pickSimulator,
  swipeActions,
  tapActions,
  toScreen,
  viewportOffset,
} from './lane.js';

describe('pickSimulator', () => {
  const list = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
        { udid: 'old', name: 'iPhone 16', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
        { udid: 'ipad', name: 'iPad Pro 13-inch (M5)', isAvailable: true },
        { udid: 'gone', name: 'iPhone 17', isAvailable: false },
        { udid: 'new', name: 'iPhone 17 Pro', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-26-1': [
        { udid: 'watch', name: 'Apple Watch Series 11', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
        { udid: 'mid', name: 'iPhone 17', isAvailable: true },
      ],
    },
  };

  test('the newest iOS runtime, an available iPhone, never an iPad or a watch', () => {
    expect(pickSimulator(list)).toEqual({
      udid: 'new',
      name: 'iPhone 17 Pro',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-1',
    });
  });

  test('falls back to an older runtime when the newest has no iPhone', () => {
    const onlyIpad = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [{ udid: 'ipad', name: 'iPad mini' }],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ udid: 'old', name: 'iPhone 16' }],
      },
    };
    expect(pickSimulator(onlyIpad).udid).toBe('old');
  });

  test('no iPhone anywhere fails loudly', () => {
    expect(() => pickSimulator({ devices: {} })).toThrow(/no available iPhone/);
  });
});

describe('appWebview', () => {
  test("prefers the context on Capacitor's origin", () => {
    expect(
      appWebview([
        'NATIVE_APP',
        { id: 'WEBVIEW_1', url: 'about:blank' },
        { id: 'WEBVIEW_2', url: 'capacitor://localhost/library' },
      ]),
    ).toBe('WEBVIEW_2');
  });

  test('bare names fall back to the first WebView', () => {
    expect(appWebview(['NATIVE_APP', 'WEBVIEW_7'])).toBe('WEBVIEW_7');
  });

  test('none yet', () => {
    expect(appWebview(['NATIVE_APP'])).toBeNull();
  });
});

describe('coordinates and gestures', () => {
  test('one calibration tap gives the whole mapping', () => {
    const offset = viewportOffset({ x: 201, y: 400 }, { x: 201, y: 338 });
    expect(offset).toEqual({ x: 0, y: 62 });
    expect(toScreen({ x: 100.4, y: 200.6 }, offset)).toEqual({ x: 100, y: 263 });
  });

  test('a swipe is down, one timed move, up — centred on the point', () => {
    const body = swipeActions({ x: 200, y: 300 }, -260, 200) as {
      actions: { actions: { type: string; x?: number; duration?: number }[] }[];
    };
    const steps = body.actions[0].actions;
    expect(steps.map((s) => s.type)).toEqual([
      'pointerMove',
      'pointerDown',
      'pointerMove',
      'pointerUp',
    ]);
    expect([steps[0].x, steps[2].x, steps[2].duration]).toEqual([330, 70, 200]);
  });

  test('a tap is down and up in place, rounded to whole points', () => {
    const body = tapActions({ x: 100.6, y: 200.2 }) as {
      actions: { actions: { type: string; x?: number; y?: number }[] }[];
    };
    const steps = body.actions[0].actions;
    expect(steps.map((s) => s.type)).toEqual(['pointerMove', 'pointerDown', 'pause', 'pointerUp']);
    expect([steps[0].x, steps[0].y]).toEqual([101, 200]);
  });

  test('only Haptics calls count as ticks', () => {
    expect(
      hapticCalls([
        { plugin: 'App', method: 'addListener' },
        { plugin: 'Haptics', method: 'impact' },
      ]),
    ).toEqual([{ plugin: 'Haptics', method: 'impact' }]);
  });
});
