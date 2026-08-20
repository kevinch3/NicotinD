import { describe, expect, it } from 'bun:test';
import { resolveAcquireAs } from './acquire-as.js';

const SPOTIFY_PLAYLIST = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
const SPOTIFY_ALBUM = 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7';
const YT_PLAYLIST = 'https://www.youtube.com/playlist?list=PL123';
const YT_WATCH_IN_LIST = 'https://www.youtube.com/watch?v=abc&list=PL123';
const YT_VIDEO = 'https://www.youtube.com/watch?v=abc';
const ARCHIVE_ITEM = 'https://archive.org/details/gd1977-05-08';

describe('resolveAcquireAs', () => {
  /**
   * The regression this exists for: the classifier's verdict was only read
   * inside the in-process engine, which the addon split retired — so a
   * playlist reached the addon as `undefined` and downloaded as one track.
   */
  it('recognizes a playlist on every source that names one in its URL', () => {
    expect(resolveAcquireAs(SPOTIFY_PLAYLIST)).toBe('playlist');
    expect(resolveAcquireAs(YT_PLAYLIST)).toBe('playlist');
    expect(resolveAcquireAs(YT_WATCH_IN_LIST)).toBe('playlist');
  });

  it('reports albums and single tracks distinctly', () => {
    expect(resolveAcquireAs(SPOTIFY_ALBUM)).toBe('album');
    expect(resolveAcquireAs(YT_VIDEO)).toBe('single');
  });

  /** archive.org exposes no playlist signal; the submitter opts in. */
  it('defaults an archive item to album, and honours the opt-in toggle', () => {
    expect(resolveAcquireAs(ARCHIVE_ITEM)).toBe('album');
    expect(resolveAcquireAs(ARCHIVE_ITEM, 'playlist')).toBe('playlist');
  });

  it('lets an override claim a link the classifier does not recognize', () => {
    expect(resolveAcquireAs('https://example.com/mix/summer')).toBeUndefined();
    expect(resolveAcquireAs('https://example.com/mix/summer', 'playlist')).toBe('playlist');
  });

  it('lets an override downgrade a recognized playlist to a single acquire', () => {
    expect(resolveAcquireAs(SPOTIFY_PLAYLIST, 'album')).toBe('album');
  });

  /** Saying nothing beats telling the addon a guess it would act on. */
  it('stays silent on an unrecognized link with no override', () => {
    expect(resolveAcquireAs('https://example.com/whatever')).toBeUndefined();
    expect(resolveAcquireAs('not a url')).toBeUndefined();
  });
});
