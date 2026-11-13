/**
 * The public demo's library: real CC0 / CC-BY / CC-BY-SA releases on the
 * Internet Archive, approved by the owner on 2026-11-13. `pin-manifest.ts`
 * turns this list into `manifest.json` (exact files + sha1), which is what the
 * Pages build fetches. `heldBack` albums are not in the library — they are what
 * the demo's simulated Get "acquires".
 */
export interface DemoAlbumSource {
  /** Internet Archive item identifier. */
  ia: string;
  genre: string;
  heldBack?: boolean;
  /** Cap on tracks taken, in track order — keeps the shipped size near 100 MB. */
  maxTracks?: number;
  /** Track titles matching this are skipped (e.g. instrumental duplicates). */
  exclude?: RegExp;
}

export const DEMO_ALBUM_SOURCES: DemoAlbumSource[] = [
  {
    ia: 'The_Simple_Life_Part_2_1667-16369',
    genre: 'Folk',
    maxTracks: 10,
    exclude: /instrumental/i,
  },
  { ia: 'Crawford_Street-17897', genre: 'Rock', maxTracks: 10, exclude: /instrumental/i },
  { ia: 'Dune-13188', genre: 'Electronic', maxTracks: 10 },
  { ia: 'Directionless_EP-8295', genre: 'Downtempo' },
  { ia: 'Komiku-TaleOnTheLate', genre: 'Soundtrack', maxTracks: 10 },
  { ia: 'Monplaisir-RelaxingUkulele', genre: 'Acoustic' },
  { ia: 'TheBlackDot', genre: 'Chiptune' },
  { ia: 'Jazz_Sampler-9619', genre: 'Jazz' },
  { ia: 'KaiEngelTheRun', genre: 'Ambient', heldBack: true },
  { ia: 'LoyaltyFreakMusic-ROLLERDISCODANCEDANCE', genre: 'Disco', heldBack: true },
];

/** Licences the demo may redistribute and transcode (no NC, no ND). */
export const ALLOWED_LICENCES = [
  /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/,
  /^https?:\/\/creativecommons\.org\/licenses\/by\/[\d.]+\/?([a-z]{2}\/?)?$/,
  /^https?:\/\/creativecommons\.org\/licenses\/by-sa\/[\d.]+\/?([a-z]{2}\/?)?$/,
];

export function isAllowedLicence(url: string): boolean {
  return ALLOWED_LICENCES.some((re) => re.test(url.trim()));
}
