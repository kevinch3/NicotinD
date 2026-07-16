import { describe, expect, it } from 'bun:test';
import { mergeDesktopConfig } from './desktop-config.js';

describe('mergeDesktopConfig', () => {
  it('adds a new key onto an empty config', () => {
    expect(mergeDesktopConfig({}, { musicDir: '/music' })).toEqual({ musicDir: '/music' });
  });

  it('overwrites an existing key', () => {
    expect(mergeDesktopConfig({ musicDir: '/old' }, { musicDir: '/new' })).toEqual({
      musicDir: '/new',
    });
  });

  it('leaves other keys untouched when the patch is empty', () => {
    expect(mergeDesktopConfig({ musicDir: '/music' }, {})).toEqual({ musicDir: '/music' });
  });
});
