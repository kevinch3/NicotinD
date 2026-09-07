import { describe, it, expect } from 'bun:test';
import { albumTitleForUrlJob } from './job-album-title';

describe('albumTitleForUrlJob', () => {
  const gondwana = 'https://open.spotify.com/intl-es/album/5aqBD2HHSWt6VpSjSZfiMw';

  it('promotes the display title for a non-playlist album link', () => {
    expect(
      albumTitleForUrlJob({ sourceUrl: gondwana, displayTitle: 'Gondwana', isPlaylist: false }),
    ).toBe('Gondwana');
  });

  it('promotes for a locale-free album link too', () => {
    expect(
      albumTitleForUrlJob({
        sourceUrl: 'https://open.spotify.com/album/abc',
        displayTitle: 'Crece',
        isPlaylist: false,
      }),
    ).toBe('Crece');
  });

  // The whole reason the protocol keeps `title` and `album` apart: a playlist
  // name as filing metadata mints a phantom album and mis-files every track.
  it('refuses a playlist, however album-shaped the link', () => {
    expect(
      albumTitleForUrlJob({
        sourceUrl: 'https://open.spotify.com/playlist/37i9dQZF1DWVYs6zNzJ0ci',
        displayTitle: 'Reggae en Español',
        isPlaylist: true,
      }),
    ).toBeNull();
    expect(
      albumTitleForUrlJob({ sourceUrl: gondwana, displayTitle: 'Gondwana', isPlaylist: true }),
    ).toBeNull();
  });

  it('refuses a track or artist link', () => {
    expect(
      albumTitleForUrlJob({
        sourceUrl: 'https://open.spotify.com/intl-es/track/abc',
        displayTitle: 'Irie',
        isPlaylist: false,
      }),
    ).toBeNull();
    expect(
      albumTitleForUrlJob({
        sourceUrl: 'https://open.spotify.com/intl-es/artist/abc',
        displayTitle: 'Gondwana',
        isPlaylist: false,
      }),
    ).toBeNull();
  });

  it('never overwrites an album title the addon already supplied', () => {
    expect(
      albumTitleForUrlJob({
        sourceUrl: gondwana,
        displayTitle: 'Gondwana',
        albumTitle: 'Real Album',
        isPlaylist: false,
      }),
    ).toBeNull();
  });

  it('returns null without a usable display title', () => {
    for (const displayTitle of [null, undefined, '', '   ']) {
      expect(
        albumTitleForUrlJob({ sourceUrl: gondwana, displayTitle, isPlaylist: false }),
      ).toBeNull();
    }
  });

  it('returns null without a source URL', () => {
    expect(albumTitleForUrlJob({ displayTitle: 'Gondwana', isPlaylist: false })).toBeNull();
  });

  // `Unknown` is what spotdl wrote into every one of these files' ALBUM tag;
  // promoting it would just re-state the problem in a different column.
  it('refuses an unknown-like display title', () => {
    for (const displayTitle of ['Unknown', 'unknown album', '[Unknown]']) {
      expect(
        albumTitleForUrlJob({ sourceUrl: gondwana, displayTitle, isPlaylist: false }),
      ).toBeNull();
    }
  });
});
