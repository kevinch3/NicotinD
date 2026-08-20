import { describe, expect, it } from 'bun:test';
import {
  parseSpotdlPlaylistTitle,
  parseSpotdlProgress,
  parseSpotdlTrackEvent,
  parseYtdlpPlaylistTitle,
  parseYtdlpProgress,
  parseYtdlpTrackEvent,
} from './downloader-output.js';

/**
 * These parsers are the only route to three things an addon cannot otherwise
 * know: the playlist's name, how many tracks were expected, and their order.
 * Both external addons currently spawn with `stdio: 'ignore'` and lose all
 * three — which is why a 1-of-16 download reports a clean "Done 1 of 1".
 */
describe('playlist titles', () => {
  it('reads a spotDL playlist name', () => {
    expect(parseSpotdlPlaylistTitle('Found 16 songs in playlist: Summer Mix 2024')).toBe(
      'Summer Mix 2024',
    );
    expect(parseSpotdlPlaylistTitle('Downloaded "Some Song"')).toBeNull();
  });

  it('reads a yt-dlp playlist name', () => {
    expect(parseYtdlpPlaylistTitle('[download] Downloading playlist: My Mix')).toBe('My Mix');
    expect(parseYtdlpPlaylistTitle('[download]  45.2% of 3MiB')).toBeNull();
  });
});

describe('expected track counts', () => {
  const zero = { done: 0, total: 0 };

  it('takes the spotDL total from "Found N songs"', () => {
    expect(parseSpotdlProgress('Found 16 songs in playlist: Mix', zero)).toEqual({
      done: 0,
      total: 16,
    });
  });

  it('counts each downloaded or skipped spotDL song', () => {
    let p = { done: 0, total: 16 };
    p = parseSpotdlProgress('Downloaded "A"', p);
    p = parseSpotdlProgress('Skipping "B"', p);
    expect(p).toEqual({ done: 2, total: 16 });
  });

  it('leaves progress untouched on an unrelated line', () => {
    expect(parseSpotdlProgress('some noise', { done: 3, total: 9 })).toEqual({ done: 3, total: 9 });
  });

  it('reads the yt-dlp playlist item counter and percent', () => {
    expect(parseYtdlpProgress('[download] Downloading item 3 of 12', zero)).toEqual({
      done: 3,
      total: 12,
    });
    expect(parseYtdlpProgress('[download]  45.2% of 3MiB', zero)).toEqual({ done: 45, total: 100 });
  });
});

describe('per-track events', () => {
  it('reads spotDL downloaded/skipped lines', () => {
    expect(parseSpotdlTrackEvent('Downloaded "Song A"')).toEqual({
      title: 'Song A',
      status: 'done',
    });
    expect(parseSpotdlTrackEvent('Skipping "Song B"')).toEqual({
      title: 'Song B',
      status: 'skipped',
    });
    expect(parseSpotdlTrackEvent('unrelated')).toBeNull();
  });

  it('reads yt-dlp markers, keeping the filename after the tab', () => {
    expect(parseYtdlpTrackEvent('TRACK_START::My Song\ttrack01.opus')).toEqual({
      title: 'My Song',
      status: 'downloading',
      path: 'track01.opus',
    });
    expect(parseYtdlpTrackEvent('TRACK_DONE::My Song')).toEqual({
      title: 'My Song',
      status: 'done',
    });
  });

  /**
   * The delimiter is a tab, not a second `::`, because yt-dlp derives the
   * filename from the title — so a title containing `::` would poison both
   * fields of a `::`-delimited marker.
   */
  it('survives a title containing the marker delimiter', () => {
    expect(parseYtdlpTrackEvent('TRACK_DONE::Artist :: Song\tfile.opus')).toEqual({
      title: 'Artist :: Song',
      status: 'done',
      path: 'file.opus',
    });
  });
});
