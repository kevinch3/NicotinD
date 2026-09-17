import { describe, expect, it } from 'bun:test';
import { androidAppId } from './app-id.js';

describe('androidAppId', () => {
  it('suffixes TV so phone and TV are separate apps', () => {
    // Sharing one id let a TV APK install over the phone one and silently swap
    // the UI, and made two F-Droid entries impossible.
    expect(androidAppId('ar.kevinroberts.nicotind', true)).toBe('ar.kevinroberts.nicotind.tv');
  });

  it('leaves the phone build on the base id', () => {
    expect(androidAppId('ar.kevinroberts.nicotind', false)).toBe('ar.kevinroberts.nicotind');
  });

  it('applies to every channel, not just F-Droid', () => {
    // There is one TV APK since #1168; an application id cannot depend on where
    // the file was downloaded from.
    expect(androidAppId('x.y', true)).toBe('x.y.tv');
  });
});
