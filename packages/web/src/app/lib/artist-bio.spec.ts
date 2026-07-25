import { describe, it, expect } from 'vitest';
import { formatArtistBio, isOverflowing, mergeArtistSources } from './artist-bio';

// The fixtures are the four real-world raw Discogs profiles from issue #213 —
// they exercise every formatter rule together (BBCode links, artist refs,
// escaped quotes, bare trailing URLs).
const ALMAFUERTE = `Heavy Metal band from Buenos Aires, Argentina, active from 1995 to 2016.
The group was named after Argentine poet ... a.k.a. [url=https://www.discogs.com/es/artist/3489580-Almafuerte-2]Almafuerte[/url].
The band was formed in 1995 by [a2427723] after [a2351513]''s disbandment, they opened for [a59770] (1995), [a18839] (1999) and [a11770] (2005).
...
https://es.wikipedia.org/wiki/Almafuerte_(banda)
https://en.wikipedia.org/wiki/Almafuerte_(band)
https://www.facebook.com/almafuerte.of/`;

const ANA_GABRIEL = `Mexican Singer, Songwriter and Producer.
Born December 10, 1955 in Guamuchil, Sinaloa, Mexico.
...
http://www.anagabriel.com.mx/
https://en.wikipedia.org/wiki/Ana_Gabriel`;

const ABBA = `'Björn & Benny, Agnetha & Anni-Frid' is what ABBA called themselves ... [url=https://www.discogs.com/artist/975170-...]Björn and Benny[/url], a duo. ...`;

const BRITNEY = `Britney Spears (born December 2, 1981) ... signing with [l=Jive] Records in 1997. ... In 1999 she released her first album [m=27117]. ...
http://www.britney.com
http://en.wikipedia.org/wiki/Britney_Spears
http://www.youtube.com/britneyspears`;

// Real prod bios (from library_artist_meta on prod) — these exercise the token
// forms Discogs's API actually returns that the original #213 fixtures missed:
// named `[a=Name]` refs (whole member lists), `[b]`/`[i]` formatting tags, and
// numeric `[lN]`/`[mN]` label/master refs (no `=`). Line endings are `\r\n`.
const DIVIDIDOS = `Argentine Alternative Rock trio, formed in 1988 after [a=Luca Prodan]'s death and the disbanding of [a=Sumo (8)].\r\n\r\n[b]Members:[/b]\r\n[a=Ricardo Mollo] - Guitar, Lead Vocals\r\n[a=Diego Arnedo] - Bass\r\n[a=Catriel Ciavarella] - Drums (since 2004)`;

const ALMENDRA = `[i]Almendra[/i] ("Almond") was one of the most important rock groups from Buenos Aires. Led by guitarist and lyricist [a1006851], between 1968 and 1971 Almendra released two albums.`;

describe('formatArtistBio', () => {
  it('returns null bio + empty urls for empty/null input', () => {
    expect(formatArtistBio(null)).toEqual({ bio: null, urls: [] });
    expect(formatArtistBio(undefined)).toEqual({ bio: null, urls: [] });
    expect(formatArtistBio('')).toEqual({ bio: null, urls: [] });
    expect(formatArtistBio('   ')).toEqual({ bio: null, urls: [] });
  });

  it('strips [url=…]Label[/url] keeping the label (Almafuerte fixture)', () => {
    const { bio } = formatArtistBio(ALMAFUERTE);
    expect(bio).toContain('a.k.a. Almáfuerte'.replace('á', 'a') + '.');
    expect(bio).not.toContain('[url=');
    expect(bio).not.toContain('[/url]');
  });

  it('strips [a…] artist refs without leaving brackets (Almafuerte fixture)', () => {
    const { bio } = formatArtistBio(ALMAFUERTE);
    expect(bio).not.toContain('[a2427723]');
    expect(bio).not.toContain('[a2351513]');
    expect(bio).not.toContain('[a59770]');
    // The text around the ref is preserved.
    expect(bio).toContain('after');
    expect(bio).toContain("'s disbandment");
  });

  it("unescapes Discogs's '' → '  (Almafuerte fixture)", () => {
    const { bio } = formatArtistBio(ALMAFUERTE);
    expect(bio).toContain("'s disbandment");
    expect(bio).not.toContain("''s");
  });

  it('extracts trailing bare URLs into urls[] (Almafuerte fixture)', () => {
    const { bio, urls } = formatArtistBio(ALMAFUERTE);
    expect(urls).toEqual([
      'https://es.wikipedia.org/wiki/Almafuerte_(banda)',
      'https://en.wikipedia.org/wiki/Almafuerte_(band)',
      'https://www.facebook.com/almafuerte.of/',
    ]);
    // The bio itself no longer carries those URL lines.
    for (const u of urls) expect(bio).not.toContain(u);
  });

  it('extracts the two trailing URLs from the Ana Gabriel fixture', () => {
    const { bio, urls } = formatArtistBio(ANA_GABRIEL);
    expect(urls).toEqual([
      'http://www.anagabriel.com.mx/',
      'https://en.wikipedia.org/wiki/Ana_Gabriel',
    ]);
    expect(bio).toContain('Mexican Singer, Songwriter and Producer.');
  });

  it('keeps [url] label and no trailing URLs (ABBA fixture — the show-more-look-the-same bug)', () => {
    const { bio, urls } = formatArtistBio(ABBA);
    // The visible label is kept; the BBCode wrapper is gone.
    expect(bio).toContain('Björn and Benny');
    expect(bio).not.toContain('[url=');
    expect(bio).not.toContain('[/url]');
    expect(urls).toEqual([]);
    // Discogs-style `'` in the first line is preserved (we only unescape
    // escaped quotes, not straight ones).
    expect(bio).toContain("'Björn & Benny, Agnetha & Anni-Frid'");
  });

  it('strips [l=…]/[m=…] wrappers keeping the embedded name (Britney fixture)', () => {
    // The named form embeds the display name (`Jive`) — keep it (no Discogs
    // call needed, the name is right there). Only numeric refs (`[l12345]`)
    // are dropped, since they carry no name. `[m=27117]` has no name → drops.
    const { bio, urls } = formatArtistBio(BRITNEY);
    expect(bio).not.toContain('[l=Jive]');
    expect(bio).not.toContain('[m=27117]');
    expect(bio).toContain('signing with Jive Records in 1997');
    expect(bio).toContain('first album');
    expect(urls).toEqual([
      'http://www.britney.com',
      'http://en.wikipedia.org/wiki/Britney_Spears',
      'http://www.youtube.com/britneyspears',
    ]);
  });

  it('keeps the name in named [a=Name] refs (Divididos member list)', () => {
    const { bio } = formatArtistBio(DIVIDIDOS);
    // The whole point: member lists must read as names, not `[a=Name]` garbage.
    expect(bio).toContain('Ricardo Mollo - Guitar, Lead Vocals');
    expect(bio).toContain('Diego Arnedo - Bass');
    expect(bio).toContain("after Luca Prodan's death");
    expect(bio).toContain('disbanding of Sumo (8)');
    expect(bio).not.toContain('[a=');
    expect(bio).not.toContain(']');
  });

  it('keeps the name in named [l=Name]/[m=Name] refs (Britney fixture)', () => {
    // Real Discogs API returns `[l=Jive]` with the name embedded — keep it.
    const { bio } = formatArtistBio(BRITNEY);
    expect(bio).toContain('signing with Jive Records in 1997');
    expect(bio).not.toContain('[l=Jive]');
    expect(bio).not.toContain('[m=27117]');
  });

  it('strips [b]/[i]/[u] formatting tags, keeping inner text (Divididos/Almendra)', () => {
    expect(formatArtistBio(DIVIDIDOS).bio).toContain('Members:');
    expect(formatArtistBio(DIVIDIDOS).bio).not.toContain('[b]');
    expect(formatArtistBio(DIVIDIDOS).bio).not.toContain('[/b]');
    const almendra = formatArtistBio(ALMENDRA).bio;
    expect(almendra).toContain('Almendra ("Almond")');
    expect(almendra).not.toContain('[i]');
    expect(almendra).not.toContain('[/i]');
  });

  it('drops numeric [aN]/[lN]/[mN]/[rN] refs without leaving brackets', () => {
    // Numeric refs carry no display name → drop them, and don't leave a
    // dangling space before the following punctuation.
    const almendra = formatArtistBio(ALMENDRA).bio;
    expect(almendra).not.toContain('[a1006851]');
    expect(almendra).toContain('guitarist and lyricist, between');
    const raw = 'On label [l12345] and master [m678] and release [r90].';
    const { bio } = formatArtistBio(raw);
    expect(bio).toBe('On label and master and release.');
  });

  it('preserves paragraph breaks', () => {
    const raw = 'First paragraph.\n\nSecond paragraph.\n\n\nThird.';
    const { bio } = formatArtistBio(raw);
    expect(bio).toBe('First paragraph.\n\nSecond paragraph.\n\nThird.');
  });

  it('leaves inline URLs alone — only whole-line URLs are extracted', () => {
    const raw = 'See https://example.com for details.\n\nAnd more prose.';
    const { bio, urls } = formatArtistBio(raw);
    expect(urls).toEqual([]);
    expect(bio).toContain('https://example.com');
  });

  it('preserves plain-text apostrophes (does not touch straight quotes)', () => {
    const { bio } = formatArtistBio("It's a band. The group's first album.");
    expect(bio).toBe("It's a band. The group's first album.");
  });
});

describe('mergeArtistSources', () => {
  it('combines and dedupes case-insensitively, preserving first occurrence', () => {
    expect(
      mergeArtistSources(
        ['https://en.wikipedia.org/wiki/X'],
        ['HTTPS://en.wikipedia.org/wiki/x', 'https://x.com'],
        [],
      ),
    ).toEqual(['https://en.wikipedia.org/wiki/X', 'https://x.com']);
  });

  it('skips blank entries', () => {
    expect(mergeArtistSources(['', '  ', 'https://x.com'])).toEqual(['https://x.com']);
  });

  it('returns [] for no inputs', () => {
    expect(mergeArtistSources()).toEqual([]);
  });
});

describe('isOverflowing', () => {
  // Drives the show-more toggle (issue #213 part 4). A char-count gate
  // (the old `bio.length > 280`) doesn't match the visual clip: a 280-char
  // bio may render wider than 4 lines, a 300-char bio may fit. This pure
  // helper reads the actual heights so the button matches what the user
  // sees.
  it('returns true when scrollHeight exceeds clientHeight (clipped)', () => {
    expect(isOverflowing({ scrollHeight: 200, clientHeight: 80 } as HTMLElement)).toBe(true);
  });

  it('returns false when content fits in the visible area (Britney bug fix)', () => {
    expect(isOverflowing({ scrollHeight: 80, clientHeight: 200 } as HTMLElement)).toBe(false);
  });

  it('tolerates a 1px sub-pixel rounding diff', () => {
    // `line-clamp` reports the *visible* height to the nearest pixel; a
    // 1px tolerance absorbs the rounding so an exactly-fitting bio doesn't
    // show a no-op toggle.
    expect(isOverflowing({ scrollHeight: 100, clientHeight: 100 } as HTMLElement)).toBe(false);
    expect(isOverflowing({ scrollHeight: 101, clientHeight: 100 } as HTMLElement)).toBe(false);
    expect(isOverflowing({ scrollHeight: 102, clientHeight: 100 } as HTMLElement)).toBe(true);
  });
});
