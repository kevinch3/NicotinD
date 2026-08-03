import { resolveLyricsScrollContainer } from './lyrics-scroll-container';

describe('resolveLyricsScrollContainer', () => {
  const lyricsPanelEl = {} as HTMLElement;
  const karaokeEl = {} as HTMLElement;

  it('picks the karaoke-fullscreen container when fullscreen is active, even if both are present', () => {
    expect(resolveLyricsScrollContainer(true, { lyricsPanelEl, karaokeEl })).toBe(karaokeEl);
  });

  it('picks the in-place lyrics-panel container when fullscreen is not active', () => {
    expect(resolveLyricsScrollContainer(false, { lyricsPanelEl, karaokeEl })).toBe(lyricsPanelEl);
  });

  it('returns null when fullscreen is active but the karaoke ref is unset (e.g. auto-follow mode, no list)', () => {
    expect(resolveLyricsScrollContainer(true, { lyricsPanelEl, karaokeEl: null })).toBeNull();
  });

  it('returns null when not fullscreen and the lyrics-panel ref is unset', () => {
    expect(resolveLyricsScrollContainer(false, { lyricsPanelEl: null, karaokeEl })).toBeNull();
  });

  it('returns null when neither ref is set', () => {
    expect(
      resolveLyricsScrollContainer(false, { lyricsPanelEl: null, karaokeEl: null }),
    ).toBeNull();
  });
});
