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

  // spotDL 4.5.x (verified against the installed source on prod) logs
  // `Found %s songs in %s (%s)` with the list's class name in parentheses —
  // there is no `playlist:` form any more. The retired in-process parser only
  // knew the old shape, so it would never have named a card on a current spotDL.
  it('reads the spotDL 4.5 "Found N songs in <name> (<Kind>)" form', () => {
    expect(parseSpotdlPlaylistTitle('Found 16 songs in Summer Mix 2024 (Playlist)')).toBe(
      'Summer Mix 2024',
    );
    expect(parseSpotdlPlaylistTitle('Found 12 songs in Ídolo (Deluxe) (Album)')).toBe(
      'Ídolo (Deluxe)',
    );
    expect(parseSpotdlPlaylistTitle('Found 1 songs in Lonely (Saved)')).toBe('Lonely');
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
    p = parseSpotdlProgress('Skipping C - D (file already exists) https://x', p);
    expect(p).toEqual({ done: 3, total: 16 });
  });

  it('takes the total from the spotDL 4.5 "Found N songs in <name> (<Kind>)" form', () => {
    expect(parseSpotdlProgress('Found 16 songs in Summer Mix 2024 (Playlist)', zero)).toEqual({
      done: 0,
      total: 16,
    });
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

  // spotDL 4.5.x skip lines carry no quotes: `Skipping <Artist - Title> (file
  // already exists) <url>` / `(skip file found)`, and `Skipping explicit song:`.
  it('reads the spotDL 4.5 unquoted skip lines', () => {
    expect(
      parseSpotdlTrackEvent(
        'Skipping Kaleb Di Masi - Techengue (file already exists) https://open.spotify.com/track/1',
      ),
    ).toEqual({ title: 'Kaleb Di Masi - Techengue', status: 'skipped' });
    expect(parseSpotdlTrackEvent('Skipping A - B (skip file found) https://x')).toEqual({
      title: 'A - B',
      status: 'skipped',
    });
    expect(parseSpotdlTrackEvent('Skipping explicit song: A - B')).toEqual({
      title: 'A - B',
      status: 'skipped',
    });
    // Matcher-internal chatter must not read as a track.
    expect(parseSpotdlTrackEvent('Skipping result due to no common words')).toBeNull();
  });

  // With `--print-errors` spotDL ends with one line per failed song:
  // `<track url> - <ExceptionName>: <message>`. The LookupError message names
  // the song; other exceptions only carry the url, which still identifies it.
  // Mid-run, spotDL logs each failure the moment it happens — `LookupError: No
  // results found for song: X` and `AudioProviderError: YT-DLP download error -
  // <youtube url>` — with no Spotify url prefix. Reading those is what lets the
  // card count failures live instead of sitting at "0 of 0" until the
  // `--print-errors` summary at the end (prod: 6 minutes of "Queued 0 of 0" on
  // a 100-track playlist where 99 were failing). The summary line for the same
  // song parses to the SAME title (the song name, or the YouTube url), so a
  // consumer keyed on title sees one failure, not two.
  it('reads the mid-run failure lines, to the same title as the end summary', () => {
    expect(parseSpotdlTrackEvent('LookupError: No results found for song: A - B')).toEqual({
      title: 'A - B',
      status: 'failed',
    });
    expect(
      parseSpotdlTrackEvent(
        'AudioProviderError: YT-DLP download error - https://www.youtube.com/watch?v=5Eed1XaWgDI',
      ),
    ).toEqual({
      title: 'https://www.youtube.com/watch?v=5Eed1XaWgDI',
      status: 'failed',
      detail: 'AudioProviderError: YT-DLP download error',
    });
    expect(
      parseSpotdlTrackEvent(
        'https://open.spotify.com/track/2IzV - AudioProviderError: YT-DLP download error - https://www.youtube.com/watch?v=5Eed1XaWgDI',
      ),
    ).toEqual({
      title: 'https://www.youtube.com/watch?v=5Eed1XaWgDI',
      status: 'failed',
      detail: 'AudioProviderError: YT-DLP download error',
    });
    // A DEBUG-format prefix must not hide it.
    expect(
      parseSpotdlTrackEvent(
        '[13:40:57] INFO     asyncio_0 - LookupError: No results found for song: A - B',
      ),
    ).toEqual({ title: 'A - B', status: 'failed' });
    // spotDL's "still trying" chatter is not a verdict.
    expect(
      parseSpotdlTrackEvent(
        'YouTube Music returned no usable results for a - b on attempt 1/3, retrying',
      ),
    ).toBeNull();
  });

  it('reads the spotDL --print-errors failure lines as failed tracks', () => {
    expect(
      parseSpotdlTrackEvent(
        'https://open.spotify.com/track/abc - LookupError: No results found for song: A - B',
      ),
    ).toEqual({ title: 'A - B', status: 'failed' });
    expect(
      parseSpotdlTrackEvent('https://open.spotify.com/track/abc - SongError: something else'),
    ).toEqual({
      title: 'https://open.spotify.com/track/abc',
      status: 'failed',
      detail: 'SongError: something else',
    });
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
