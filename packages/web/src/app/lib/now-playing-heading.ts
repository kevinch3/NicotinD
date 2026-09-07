import { describeLibraryFilter, type LibraryFilter } from '@nicotind/core';
import type { PlayContext } from '../services/player.service';

export interface NowPlayingHeadingInput {
  radio: boolean;
  radioFilter: LibraryFilter | null;
  context: PlayContext | null;
  /** The playing track, the last resort for naming a seed radio. */
  trackTitle?: string | null;
}

/** An i18n key plus its params — resolved by the caller's `TranslateService`. */
export interface NowPlayingHeading {
  key: string;
  params?: Record<string, string>;
}

const nonEmpty = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
};

/**
 * What the Now Playing header should call the current session.
 *
 * The header said `NOW PLAYING` and nothing else, whatever was playing — so a
 * radio, an album and an ad-hoc queue were indistinguishable at the top of the
 * sheet (issue #996). The signal was already there: `player.context()` carries
 * `{ type, name }` and the queue panel one component over has always read it.
 *
 * **Radio wins over the context it extended.** A playlist that quietly became a
 * radio still read as the playlist, which is the case that confuses people
 * most: the thing choosing the next track was not the thing named at the top.
 * So when the radio is on the heading says *radio*, and names what the radio is
 * about — its station filter, else the album/playlist it grew out of, else the
 * track it seeded from.
 *
 * An ad-hoc queue is genuinely undetermined and says nothing extra, which is
 * why `adhoc` falls through to the plain title rather than inventing a label.
 *
 * Pure: the JIT vitest harness cannot construct a component with signal inputs,
 * and this is the part worth testing.
 */
export function nowPlayingHeading(input: NowPlayingHeadingInput): NowPlayingHeading {
  const contextName =
    input.context && input.context.type !== 'adhoc' ? nonEmpty(input.context.name) : null;

  if (input.radio) {
    const station = input.radioFilter ? nonEmpty(describeLibraryFilter(input.radioFilter)) : null;
    const about = station ?? contextName ?? nonEmpty(input.trackTitle);
    return about
      ? { key: 'nowPlaying.headingRadioAbout', params: { name: about } }
      : { key: 'nowPlaying.headingRadio' };
  }

  if (!contextName) return { key: 'nowPlaying.title' };
  switch (input.context!.type) {
    case 'album':
      return { key: 'nowPlaying.headingAlbum', params: { name: contextName } };
    case 'playlist':
      return { key: 'nowPlaying.headingPlaylist', params: { name: contextName } };
    case 'saved-offline':
      return { key: 'nowPlaying.headingOffline', params: { name: contextName } };
    default:
      return { key: 'nowPlaying.title' };
  }
}
