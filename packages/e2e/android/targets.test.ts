import { describe, expect, test } from 'bun:test';
import {
  parseTarget,
  parseVibrations,
  targetFor,
  toDevicePoint,
  vibrationsSince,
  webViewOrigin,
} from './targets.js';

// Two lines as `dumpsys vibrator_manager` printed them on the Pixel 6 AVD (API 36),
// plus one from the shell and one from the TV package, which must not count.
const DUMPSYS = `
  Recent vibrations:
    TOUCH:
      11-15 10:47:07.269 |   effect |             finished | duration:    87ms | start: 10:47:07.272 | end: 10:47:07.356 | scale:     NONE (adaptive=1.00) | flags:    0 | usage: TOUCH | ar.kevinroberts.nicotind (uid=10216, deviceId=0) | reason: null | played: [Step=0ms(amplitude=0.00),Step=50ms(amplitude=0.43)] | original: null
      11-15 10:47:09.001 |   effect |             finished | duration:    87ms | start: 10:47:09.004 | end: 10:47:09.090 | scale:     NONE (adaptive=1.00) | flags:    0 | usage: TOUCH | ar.kevinroberts.nicotind.tv (uid=10217, deviceId=0) | reason: null | played: [Step=50ms(amplitude=0.43)] | original: null
    COMMUNICATION_REQUEST:
      11-15 10:42:46.650 |   effect |             finished | duration:   140ms | start: 10:42:46.715 | end: 10:42:46.790 | scale:     NONE (adaptive=1.00) | flags:   11 | usage: COMMUNICATION_REQUEST | com.android.shell (uid=2000, deviceId=0) | reason: Shell command | played: Step=40ms(amplitude=1.00) | original: Step=40ms(amplitude=-1.00)
      11-15 10:40:01.500 |   effect |             finished | duration:    87ms | start: 10:40:01.502 | end: 10:40:01.590 | scale:     NONE (adaptive=1.00) | flags:    0 | usage: TOUCH | ar.kevinroberts.nicotind (uid=10216, deviceId=0) | reason: null | played: [Step=50ms(amplitude=0.43)] | original: null
`;

describe('parseVibrations', () => {
  test('keeps only the app, never the .tv package or the shell, oldest first', () => {
    const v = parseVibrations(DUMPSYS, 'ar.kevinroberts.nicotind');
    expect(v.map((x) => x.at)).toEqual(['11-15 10:40:01.500', '11-15 10:47:07.269']);
    expect(v[1]).toEqual({
      at: '11-15 10:47:07.269',
      usage: 'TOUCH',
      played: '[Step=0ms(amplitude=0.00),Step=50ms(amplitude=0.43)]',
    });
  });

  test('the TV package is matched on its own id', () => {
    expect(parseVibrations(DUMPSYS, 'ar.kevinroberts.nicotind.tv')).toHaveLength(1);
  });

  test('vibrationsSince is strictly after the mark', () => {
    const v = parseVibrations(DUMPSYS, 'ar.kevinroberts.nicotind');
    expect(vibrationsSince(v, '11-15 10:40:01.500').map((x) => x.at)).toEqual([
      '11-15 10:47:07.269',
    ]);
    expect(vibrationsSince(v, '11-15 10:47:07.269')).toEqual([]);
  });
});

describe('webViewOrigin + toDevicePoint', () => {
  const xml =
    '<node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">' +
    '<node index="0" text="" resource-id="" class="android.webkit.WebView" package="ar.kevinroberts.nicotind" bounds="[0,128][1080,2337]">' +
    '<node class="android.view.View" bounds="[0,200][10,210]"/></node></node>';

  test('reads the WebView node, not its parent or its children', () => {
    expect(webViewOrigin(xml)).toEqual({ left: 0, top: 128 });
  });

  test('throws when there is no WebView, rather than swiping at the status bar', () => {
    expect(() => webViewOrigin('<node class="android.widget.FrameLayout"/>')).toThrow(/WebView/);
  });

  test('scales by the device pixel ratio and offsets by the origin', () => {
    expect(toDevicePoint({ x: 206, y: 188.2 }, 2.625, { left: 0, top: 128 })).toEqual({
      x: 541,
      y: 622,
    });
  });
});

describe('targets', () => {
  test('--target picks the lane and is not passed to Playwright', () => {
    expect(parseTarget(['--target=phone', '--grep', 'tick'])).toEqual({
      target: 'phone',
      rest: ['--grep', 'tick'],
    });
  });

  test('no --target keeps the original TV invocation working', () => {
    expect(parseTarget(['--grep', 'notch']).target).toBe('tv');
  });

  test('an unknown target fails loudly', () => {
    expect(() => parseTarget(['--target=ios'])).toThrow(/tv or phone/);
  });

  test('the lanes never share a package, a port, an AVD or a flavour', () => {
    const tv = targetFor('tv', {});
    const phone = targetFor('phone', {});
    for (const key of ['appId', 'port', 'avd', 'flavour', 'config'] as const) {
      expect(tv[key]).not.toBe(phone[key]);
    }
  });

  test('per-lane overrides', () => {
    const phone = targetFor('phone', {
      E2E_PHONE_PORT: '9000',
      E2E_PHONE_AVD: 'p',
      E2E_PHONE_SERIAL: 's',
    });
    expect([phone.port, phone.avd, phone.serial]).toEqual(['9000', 'p', 's']);
    expect(targetFor('tv', { E2E_TV_PORT: '9001' }).port).toBe('9001');
  });
});
