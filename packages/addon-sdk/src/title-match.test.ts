import { describe, expect, it } from 'bun:test';
import {
  filesMatchingTitles,
  fileTitleScore,
  foldTitleText,
  matchFilesToTitles,
  normalizeFileBasename,
  normalizeTitle,
  titlesMissingFromOwned,
  titlesOverlap,
} from './title-match.js';

describe('normalizeTitle', () => {
  it('folds accents, strips track numbers and punctuation', () => {
    expect(normalizeTitle('03 - Canción de Amor!')).toBe('cancion de amor');
    expect(normalizeTitle('  Weird   spacing ')).toBe('weird spacing');
  });

  it('strips a leading digit even when it is part of the title (#1089)', () => {
    // normalizeTitle matches peer FILENAMES, where a leading number is
    // virtually always a track prefix — this is intentionally unconditional.
    // A caller with the file's own track number (the library layer) needs
    // `foldTitleText` instead so it can decide for itself; see its test below.
    expect(normalizeTitle('7 Steps')).toBe('steps');
  });

  it('keeps non-Latin titles distinct instead of collapsing them to ""', () => {
    // `\w` is ASCII-only, so every Cyrillic/CJK/Hangul/Arabic title normalized
    // to "" — which made `titlesOverlap` return true for every pair of them.
    const titles = ['Группа крови', 'Ночь', '東京事変', '教育', '방탄소년단', 'أم كلثوم'];
    const normalized = titles.map(normalizeTitle);
    expect(normalized).not.toContain('');
    expect(new Set(normalized).size).toBe(titles.length);
  });
});

describe('foldTitleText', () => {
  // Punctuation-strip + whitespace-collapse only — no lowercasing/diacritic
  // fold (that's `fold`, applied by callers before this) and no digit strip
  // (that's the caller's call, per #1089).
  it('strips punctuation and collapses whitespace without touching case or a leading digit', () => {
    expect(foldTitleText('7 Steps!')).toBe('7 Steps');
    expect(foldTitleText('  Weird   spacing ')).toBe('Weird spacing');
  });
});

describe('titlesOverlap', () => {
  it('accepts an exact match and a 70% word overlap', () => {
    expect(titlesOverlap('cancion de amor', 'cancion de amor')).toBe(true);
    expect(titlesOverlap('cancion de amor', 'cancion de amor remaster')).toBe(true);
  });

  it('rejects a weak overlap and an empty canonical', () => {
    expect(titlesOverlap('cancion de amor', 'something else entirely')).toBe(false);
    expect(titlesOverlap('', 'x')).toBe(false);
  });

  it('does not match two unrelated non-Latin titles', () => {
    // Both normalized to "", so the `canonical === filename` fast path made
    // every pair of non-Latin titles "the same track".
    expect(titlesOverlap(normalizeTitle('Ночь'), normalizeTitle('Группа крови'))).toBe(false);
  });
});

describe('filesMatchingTitles (the slskd addon coverage rule, #1209)', () => {
  const folder = [
    { filename: 'Music\\Artist\\Album\\01 - Canción de Amor.flac' },
    { filename: 'Music/Artist/Album/02 Otra Canción.mp3' },
  ];

  it('keeps only the files that carry a wanted title, accent-folded', () => {
    expect(filesMatchingTitles(folder, ['Otra cancion'])).toEqual([folder[1]]);
  });

  it('is empty when the folder carries none of the wanted titles', () => {
    expect(filesMatchingTitles(folder, ['Bonus Track (Demo)'])).toEqual([]);
  });

  it('normalizes a basename by dropping the path, extension and track prefix', () => {
    expect(normalizeFileBasename('Music\\A\\03 - Tictac.opus')).toBe('tictac');
  });
});

// The 2026-09-29 curation acquire pass (#1468): every file a missing-track
// hunt downloaded, with the album's canonical tracklist. The first three are
// neighbouring tracks the album already owned; the old one-sided rule (70% of
// the WANTED words present) took all three.
const UNTOLD_STORIES = [
  'Ortni',
  'Violintermezzo',
  'Arpeggiator Stories',
  'Arpeggiator Stories Continued',
  'Harpy',
];
const LO_MEJOR_DE = [
  'Separate',
  'Profundo valor',
  'Caradura',
  'Dime la verdad',
  'De mujer a mujer',
];
const SPINETTALANDIA = [
  'Dame, dame pan',
  'Estrella',
  'La búsqueda de la estrella',
  'Vamos al bosque',
];
const EL_MADRILENO = [
  'Nominao',
  'Te olvidaste',
  'Los tontos',
  'Yate',
  "Los tontos (Live at NPR's Tiny Desk)",
  'Para repartir',
];

const PASS_2026_09_29: Array<[string, string, string[], boolean]> = [
  [
    'Arpeggiator Stories',
    'Untold Stories (2010)/04 - Eelke Kleijn - Arpeggiator Stories Continued.mp3',
    UNTOLD_STORIES,
    false,
  ],
  [
    'De mujer a mujer',
    'Lo Mejor De Marta Sánchez/17 De Mujer A Mujer, Profundo Valor.mp3',
    LO_MEJOR_DE,
    false,
  ],
  [
    'Estrella',
    '1971 - Spinettalandia/06 - Luis Alberto Spinetta - Spinettalandia y sus amigos - La búsqueda de la estrella.flac',
    SPINETTALANDIA,
    false,
  ],
  [
    'Sexy Dance',
    '(Mp3-Album) Paulina Rubio - Paulina (2000)/07 Paulina Rubio - Sexy Dance.mp3',
    ['Sin aire', 'Sexy Dance'],
    true,
  ],
  [
    'Besos perdidos (Manhã de Carnaval)',
    '(2006) Club Atlético Decadente/14. Besos perdidos (Manhã de Carnaval) [3m47s][320 44100KHz CBR 2ch].mp3',
    ['Somos', 'Besos perdidos (Manhã de Carnaval)'],
    true,
  ],
  [
    'Molotov Coktail Party',
    '¿Dónde jugarán las niñas! (1997)/Molotov - 02 - Molotov Coktail Party.flac',
    ['Voto latino', 'Molotov Coktail Party', 'Voto latino (remix)'],
    true,
  ],
  [
    'Cristo es Marquitos Di Palma',
    'Ruli (2013)/10 - Cristo es Marquitos Di Palma.flac',
    ['La 13', 'Cristo es Marquitos Di Palma'],
    true,
  ],
  [
    'The Weekend',
    'Analog Is On (2007)/01 - The Weekend.flac',
    ['The Weekend', 'The Asteroid'],
    true,
  ],
  [
    'Nominao',
    'C. Tangana - El Madrileño (2022)/07 - Nominao Feat. Jorge Drexler.flac',
    EL_MADRILENO,
    true,
  ],
  [
    'Te olvidaste',
    'C. Tangana - El Madrileño (2022)/09 - Te Olvidaste Feat. Omar Apollo.flac',
    EL_MADRILENO,
    true,
  ],
  [
    'Los tontos',
    "C. Tangana - El Madrileño (2022)/21 - Los Tontos Feat. Kiko Veneno (Live At Npr's Tiny Desk).flac",
    EL_MADRILENO,
    false,
  ],
  ['Para repartir', 'C. Tangana - El Madrileño (2022)/23 - Para Repartir.flac', EL_MADRILENO, true],
];

describe('matchFilesToTitles (#1468: a longer, different title is another track)', () => {
  it.each(PASS_2026_09_29)('%s ← %s', (wanted, filename, canonical, expected) => {
    const files = [{ filename }];
    // With the album's tracklist (both callers have it) and without it: the
    // symmetric score alone must already refuse the neighbour.
    expect(filesMatchingTitles(files, [wanted], canonical)).toEqual(expected ? files : []);
    expect(filesMatchingTitles(files, [wanted])).toEqual(expected ? files : []);
  });

  it('forgives a version qualifier or a year, not another word', () => {
    expect(fileTitleScore('The Weekend', '01 - The Weekend (Radio Edit).flac')).toBeGreaterThan(0);
    expect(fileTitleScore('Hey Jude', '07 - Hey Jude (2009 Remaster).flac')).toBeGreaterThan(0);
    expect(fileTitleScore('Yate', '17 - Yate (Live).flac')).toBeGreaterThan(0);
    expect(fileTitleScore('Sexy Dance', '07 - Sexy Dance (Remix).flac')).toBe(0);
    expect(fileTitleScore('Arpeggiator Stories', '04 - Arpeggiator Stories Continued.mp3')).toBe(0);
  });

  it('keeps only the closest file per wanted title, never also the superset', () => {
    const folder = [
      { filename: 'Untold Stories/03 - Eelke Kleijn - Arpeggiator Stories.mp3' },
      { filename: 'Untold Stories/03 - Eelke Kleijn - Arpeggiator Stories (Radio Edit).mp3' },
      { filename: 'Untold Stories/04 - Eelke Kleijn - Arpeggiator Stories Continued.mp3' },
    ];
    expect(filesMatchingTitles(folder, ['Arpeggiator Stories'], UNTOLD_STORIES)).toEqual([
      folder[0],
    ]);
  });

  it('assigns a file to the album track it matches best, taking it only for a wanted one', () => {
    const folder = [
      { filename: 'El Madrileño/13 - Los Tontos.flac' },
      { filename: "El Madrileño/21 - Los Tontos (Live at NPR's Tiny Desk).flac" },
    ];
    // The live take is the owned track 21, not the wanted studio track 13.
    expect(matchFilesToTitles(folder, ['Los tontos'], EL_MADRILENO)).toEqual([
      { file: folder[0], title: 'Los tontos', score: 1 },
    ]);
    expect(filesMatchingTitles([folder[1]], ['Los tontos'], EL_MADRILENO)).toEqual([]);
  });

  it('matches each of several wanted titles to its own file, in folder order', () => {
    const folder = [
      { filename: 'A/01 - Ortni.flac' },
      { filename: 'A/02 - Violintermezzo.flac' },
      { filename: 'A/05 - Harpy.flac' },
    ];
    expect(
      matchFilesToTitles(folder, ['Harpy', 'Ortni'], UNTOLD_STORIES).map((m) => m.title),
    ).toEqual(['Ortni', 'Harpy']);
  });

  it('keeps the one-sided rule for a whole-album hunt, where no neighbour is owned', () => {
    const folder = [
      { filename: 'A/03 - Arpeggiator Stories (Kleijn Rework).mp3' },
      { filename: 'A/04 - Arpeggiator Stories Continued.mp3' },
    ];
    const album = ['Arpeggiator Stories', 'Arpeggiator Stories Continued'];
    expect(matchFilesToTitles(folder, album, album).map((m) => m.title)).toEqual(album);
    // The same folder for a missing-track hunt: only the exact neighbour is known,
    // and the rework is not "Arpeggiator Stories".
    expect(filesMatchingTitles(folder, ['Arpeggiator Stories'], album)).toEqual([]);
  });
});

// Every case is an album the prod replay moved (#1473): the old on-disk check
// was one-sided, so an owned title hid any canonical title it shared words with.
describe('titlesMissingFromOwned (#1473)', () => {
  it('does not let a shorter owned title own a longer, different one', () => {
    expect(titlesMissingFromOwned(['Love Me', 'Love Me Tender'], ['love me'])).toEqual([
      'Love Me Tender',
    ]);
    expect(
      titlesMissingFromOwned(
        ['Se remata el siglo I', 'Se remata el siglo II'],
        ['se remata el siglo i'],
      ),
    ).toEqual(['Se remata el siglo II']);
  });

  it('does not let a longer owned title own a shorter, different one', () => {
    expect(
      titlesMissingFromOwned(
        ['Arpeggiator Stories', 'Intro'],
        ['arpeggiator stories continued', 'intro'],
      ),
    ).toEqual(['Arpeggiator Stories']);
  });

  it('counts each owned title toward its closest track only', () => {
    expect(
      titlesMissingFromOwned(
        ['Theme for Spliffy (intro mix)', 'Theme for Spliffy'],
        ['theme for spliffy'],
      ),
    ).toEqual(['Theme for Spliffy (intro mix)']);
    expect(
      titlesMissingFromOwned(
        ['Electrica Salsa', 'Electrica Salsa (Extended)'],
        ['electrica salsa', 'electrica salsa remix'],
      ),
    ).toEqual(['Electrica Salsa (Extended)']);
  });

  it('forgives a version qualifier and a feat. credit on either side', () => {
    expect(titlesMissingFromOwned(['Vivo (Alive)'], ['vivo alive album version'])).toEqual([]);
    expect(titlesMissingFromOwned(['Hey Jude (2009 Remaster)'], ['hey jude'])).toEqual([]);
    expect(titlesMissingFromOwned(['Los tontos'], ['Los tontos (feat. Kiko Veneno)'])).toEqual([]);
  });

  it('owns nothing from an empty library and everything from an exact one', () => {
    expect(titlesMissingFromOwned(['A', 'B'], [])).toEqual(['A', 'B']);
    expect(titlesMissingFromOwned(['Ночь', 'Группа крови'], ['ночь', 'группа крови'])).toEqual([]);
  });
});
