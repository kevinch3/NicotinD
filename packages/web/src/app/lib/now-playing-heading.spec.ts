import { describe, it, expect } from 'vitest';
import { nowPlayingHeading } from './now-playing-heading';
import type { PlayContext } from '../services/player.service';

const ctx = (type: PlayContext['type'], name?: string): PlayContext => ({
  type,
  name,
  originalOrder: [],
});

describe('nowPlayingHeading', () => {
  it('names an album and a playlist', () => {
    expect(
      nowPlayingHeading({ radio: false, radioFilter: null, context: ctx('album', 'Crece') }),
    ).toEqual({ key: 'nowPlaying.headingAlbum', params: { name: 'Crece' } });
    expect(
      nowPlayingHeading({ radio: false, radioFilter: null, context: ctx('playlist', 'Reggae') }),
    ).toEqual({ key: 'nowPlaying.headingPlaylist', params: { name: 'Reggae' } });
  });

  // An ad-hoc queue is genuinely undetermined; inventing a label would be worse
  // than the plain title.
  it('says nothing extra for an ad-hoc queue, or a context with no name', () => {
    expect(nowPlayingHeading({ radio: false, radioFilter: null, context: ctx('adhoc') }).key).toBe(
      'nowPlaying.title',
    );
    expect(nowPlayingHeading({ radio: false, radioFilter: null, context: null }).key).toBe(
      'nowPlaying.title',
    );
    expect(
      nowPlayingHeading({ radio: false, radioFilter: null, context: ctx('album', '  ') }).key,
    ).toBe('nowPlaying.title');
  });

  /**
   * The case the issue calls out as most confusing: a playlist that quietly
   * became a radio still read as the playlist, so the thing choosing the next
   * track was not the thing named at the top.
   */
  it('lets radio win over the context it extended, and names that context', () => {
    expect(
      nowPlayingHeading({ radio: true, radioFilter: null, context: ctx('playlist', 'Reggae') }),
    ).toEqual({ key: 'nowPlaying.headingRadioAbout', params: { name: 'Reggae' } });
  });

  it('prefers the station filter over the context it extended', () => {
    const h = nowPlayingHeading({
      radio: true,
      radioFilter: { genres: ['reggae'] },
      context: ctx('album', 'Crece'),
    });
    expect(h.key).toBe('nowPlaying.headingRadioAbout');
    expect(h.params!['name']).not.toBe('Crece');
    expect(h.params!['name'].length).toBeGreaterThan(0);
  });

  it('falls back to the seed track, then to a bare Radio', () => {
    expect(
      nowPlayingHeading({
        radio: true,
        radioFilter: null,
        context: ctx('adhoc'),
        trackTitle: 'Irie',
      }),
    ).toEqual({ key: 'nowPlaying.headingRadioAbout', params: { name: 'Irie' } });
    expect(
      nowPlayingHeading({ radio: true, radioFilter: null, context: null, trackTitle: null }),
    ).toEqual({ key: 'nowPlaying.headingRadio' });
  });
});
