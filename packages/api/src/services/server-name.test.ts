import { describe, expect, it } from 'bun:test';
import { resolveServerName } from './server-name.js';

describe('resolveServerName', () => {
  it('prefers the operator’s explicit name', () => {
    expect(
      resolveServerName({
        explicit: " Kevin's Music ",
        publicUrl: 'https://a.example',
        host: 'box',
      }),
    ).toBe("Kevin's Music");
  });

  it('then the public URL host people know the server by', () => {
    expect(
      resolveServerName({ publicUrl: 'https://music.example.com/', host: '95fe07a0e91c' }),
    ).toBe('music.example.com');
  });

  it('never shows a Docker container id', () => {
    expect(resolveServerName({ host: '95fe07a0e91c' })).toBe('NicotinD');
    expect(resolveServerName({ host: 'a'.repeat(64) })).toBe('NicotinD');
    expect(resolveServerName({ host: 'localhost' })).toBe('NicotinD');
  });

  it('keeps a hostname a person chose', () => {
    expect(resolveServerName({ host: 'living-room-nas' })).toBe('living-room-nas');
  });

  it('ignores an unparseable public URL', () => {
    expect(resolveServerName({ publicUrl: 'not a url', host: 'nas' })).toBe('nas');
  });
});
