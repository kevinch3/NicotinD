import { describe, expect, it } from 'bun:test';
import {
  downloadTitleFor,
  humanizeSlug,
  isHumanSlug,
  titleFromAcquireUrl,
} from './download-title.js';

const text = (t: ReturnType<typeof downloadTitleFor>): string | null =>
  t.kind === 'text' ? t.text : null;

describe('humanizeSlug', () => {
  it('turns a hyphenated slug into prose', () => {
    expect(humanizeSlug('rodopiado-veneno-feat-sophia-ardessore')).toBe(
      'Rodopiado Veneno Feat Sophia Ardessore',
    );
  });

  it('only touches the first letter of a word, so acronyms survive', () => {
    expect(humanizeSlug('live-at-the-BBC-pt.-II')).toBe('Live At The BBC Pt. II');
  });

  it('decodes percent-escapes and collapses separators', () => {
    expect(humanizeSlug('caf%C3%A9_tacvba__re')).toBe('Café Tacvba Re');
  });

  it('survives a malformed escape instead of throwing', () => {
    expect(humanizeSlug('100%-real')).toBe('100% Real');
  });
});

describe('isHumanSlug', () => {
  it('accepts something a person wrote', () => {
    expect(isHumanSlug('rodopiado-veneno')).toBe(true);
    expect(isHumanSlug('Discovery')).toBe(true);
  });

  it('rejects pure ids and routing words', () => {
    expect(isHumanSlug('7142216')).toBe(false); // beatport's trailing release id
    expect(isHumanSlug('es')).toBe(false); // locale prefix
    expect(isHumanSlug('release')).toBe(false); // route word
  });

  /** Guessing wrong is worse than not guessing: an id as a title is noise. */
  it('rejects separator-less opaque ids', () => {
    expect(isHumanSlug('37i9dQZF1DXcBWIGoYBM5M')).toBe(false); // Spotify base62
    expect(isHumanSlug('dQw4w9WgXcQ')).toBe(false); // YouTube video id
  });
});

describe('titleFromAcquireUrl', () => {
  it('names a beatport release from its slug, skipping the numeric id', () => {
    const t = titleFromAcquireUrl(
      'https://www.beatport.com/es/release/rodopiado-veneno-feat-sophia-ardessore/7142216',
    );
    expect(t).toEqual({
      kind: 'text',
      text: 'Rodopiado Veneno Feat Sophia Ardessore',
      subtitle: 'beatport.com',
    });
  });

  /**
   * Spotify/YouTube name their content only by opaque id, so the honest answer
   * is the *shape* of the thing — "Spotify playlist" beats a humanized base62.
   */
  it('declines to humanize a Spotify id, reporting the kind instead', () => {
    expect(titleFromAcquireUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toEqual(
      {
        kind: 'source',
        urlKind: 'playlist',
      },
    );
  });

  it('reports a YouTube watch link as a track and a list link as a playlist', () => {
    expect(titleFromAcquireUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      kind: 'source',
      urlKind: 'track',
    });
    expect(titleFromAcquireUrl('https://www.youtube.com/playlist?list=PL123')).toEqual({
      kind: 'source',
      urlKind: 'playlist',
    });
  });

  it('humanizes an archive.org identifier', () => {
    expect(text(titleFromAcquireUrl('https://archive.org/details/gd1977-05-08')!)).toBe(
      'Gd1977 05 08',
    );
  });

  it('gives up rather than inventing one when the path is all ids', () => {
    expect(titleFromAcquireUrl('https://example.com/track/7142216')).toBeNull();
    expect(titleFromAcquireUrl('not a url')).toBeNull();
  });
});

describe('downloadTitleFor', () => {
  it('prefers the addon-supplied display title above everything', () => {
    const t = downloadTitleFor({
      displayTitle: 'Summer Mix 2024',
      albumTitle: 'Whatever',
      artistName: 'Various',
      sourceUrl: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    });
    expect(t).toEqual({ kind: 'text', text: 'Summer Mix 2024', subtitle: 'Various' });
  });

  it('falls to the canonical album, then to where the files landed', () => {
    expect(text(downloadTitleFor({ albumTitle: 'Heathen', artistName: 'Bowie' }))).toBe('Heathen');
    expect(
      downloadTitleFor({
        destinationAlbums: [{ albumId: 'a', albumArtist: 'Bowie', albumTitle: 'Heathen' }],
      }),
    ).toEqual({ kind: 'text', text: 'Heathen', subtitle: 'Bowie' });
  });

  it('counts the rest when a job landed in several albums', () => {
    expect(
      text(
        downloadTitleFor({
          destinationAlbums: [
            { albumId: 'a', albumArtist: 'X', albumTitle: 'One' },
            { albumId: 'b', albumArtist: 'Y', albumTitle: 'Two' },
            { albumId: 'c', albumArtist: 'Z', albumTitle: 'Three' },
          ],
        }),
      ),
    ).toBe('One +2 more');
  });

  /** The user's own suggestion: a Soulseek folder name describes the release. */
  it("names a peer grab by the uploader's folder", () => {
    expect(
      text(
        downloadTitleFor({
          items: [
            { filename: '@@abc\\music\\Los Tekis - (1995) Toque [FLAC]\\01 - Uno.mp3' },
            { filename: '@@abc\\music\\Los Tekis - (1995) Toque [FLAC]\\02 - Dos.mp3' },
          ],
        }),
      ),
    ).toBe('Los Tekis - (1995) Toque');
  });

  it('takes the folder most files came from, not the first one seen', () => {
    expect(
      text(
        downloadTitleFor({
          items: [
            { filename: 'peer/Stray Folder/x.mp3' },
            { filename: 'peer/Real Album/01.mp3' },
            { filename: 'peer/Real Album/02.mp3' },
          ],
        }),
      ),
    ).toBe('Real Album');
  });

  it('skips a generic container folder rather than showing it', () => {
    expect(downloadTitleFor({ items: [{ filename: 'peer\\Music\\01.mp3' }] }).kind).toBe('source');
    expect(downloadTitleFor({ items: [{ filename: 'peer\\CD1\\01.mp3' }] }).kind).toBe('source');
  });

  it('uses a bare artist name only once nothing more specific is left', () => {
    expect(text(downloadTitleFor({ artistName: 'Bowie' }))).toBe('Bowie');
  });

  /** The uploader's folder describes the release; the artist alone does not. */
  it('prefers the source folder over a bare artist name', () => {
    expect(
      text(
        downloadTitleFor({
          artistName: 'Bowie',
          items: [{ filename: 'peer\\Bowie - Heathen (2002) [FLAC]\\01.flac' }],
        }),
      ),
    ).toBe('Bowie - Heathen (2002)');
  });

  it('falls back to the pasted link before giving up', () => {
    expect(
      text(
        downloadTitleFor({
          sourceUrl:
            'https://www.beatport.com/es/release/rodopiado-veneno-feat-sophia-ardessore/7142216',
        }),
      ),
    ).toBe('Rodopiado Veneno Feat Sophia Ardessore');
  });

  it('reports the bare source when nothing at all is known', () => {
    expect(downloadTitleFor({})).toEqual({ kind: 'source' });
  });

  /** Internals must never surface: they are what the chain exists to replace. */
  it('never leaks an addon key or a job id', () => {
    const t = downloadTitleFor({ sourceUrl: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7' });
    expect(JSON.stringify(t)).not.toContain('addon:');
  });
});
