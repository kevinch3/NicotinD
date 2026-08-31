import { describe, expect, test } from 'bun:test';
import { AUDIO_EXTENSIONS } from '@nicotind/core';
import { LOSSLESS } from './library-track-select.js';

describe('LOSSLESS ⊆ AUDIO_EXTENSIONS', () => {
  test('every lossless format the app standardizes is one it can index', () => {
    // `.ape` and `.wv` were in LOSSLESS but not in any scanner extension set,
    // so the app advertised standardizing formats it could never scan (#845).
    const missing = [...LOSSLESS].filter((s) => !AUDIO_EXTENSIONS.has(`.${s}`));
    expect(missing).toEqual([]);
  });
});
