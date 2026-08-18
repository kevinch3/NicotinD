/**
 * Artist origin (nationality) vocabulary — the closed standard shared by the
 * API (enrichment, radio scoring, filter SQL) and the web UI (filter panel,
 * artist page). Browser-safe: types + pure functions only, no IO.
 *
 * Canonical machine codes are uppercase ISO 3166-1 alpha-2, stored in
 * `library_artist_origins.country`. Unknown origin is row-absent (never a
 * literal "unknown"), so the background enrichment task keeps retrying;
 * MusicBrainz's special codes XW (worldwide) / XE (Europe) carry no matching
 * signal and normalize to null. Display names are NOT shipped — the UI uses
 * `Intl.DisplayNames(locale, { type: 'region' })`, which localizes for free.
 *
 * Regions are musical-cultural, not geographic-textbook (see
 * docs/artist-origin.md for the grouping rationale); tier values are
 * calibrated against the real library via `dump-radio.ts --weights`.
 */

const ISO_3166_1_ALPHA_2 = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
    'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
    'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
    'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);

/** Every ISO code, sorted — the web country picker's search corpus. */
export const ALL_COUNTRY_CODES: readonly string[] = [...ISO_3166_1_ALPHA_2].sort();

/** MusicBrainz special area codes that are not countries. */
const MB_NON_COUNTRY = new Set(['XW', 'XE']);

export function isCountryCode(v: unknown): v is string {
  return typeof v === 'string' && !MB_NON_COUNTRY.has(v) && ISO_3166_1_ALPHA_2.has(v);
}

/** Uppercase + validate a raw MB/tag country value; null for anything else. */
export function normalizeMbCountry(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const code = raw.trim().toUpperCase();
  return isCountryCode(code) ? code : null;
}

export type OriginSuperRegion =
  'latin-america' | 'anglosphere' | 'europe' | 'africa' | 'mena' | 'asia';

/**
 * Musical-cultural regions. Owner-curated data, deliberately opinionated:
 * the anglosphere groups the UK/US/AU rock-pop lineage; iberia stays european
 * despite the language tie to latin-america (cross-super pairs score the 0.1
 * floor — a future affinity table could refine that). A country absent from
 * every region (e.g. AQ) exact-matches at 1.0 and floors at 0.1 against
 * everything else.
 */
export const ORIGIN_REGIONS: Record<
  string,
  { countries: readonly string[]; superRegion: OriginSuperRegion }
> = {
  'rio-de-la-plata': { countries: ['AR', 'UY', 'PY'], superRegion: 'latin-america' },
  andean: { countries: ['BO', 'PE', 'EC', 'CL'], superRegion: 'latin-america' },
  brazil: { countries: ['BR'], superRegion: 'latin-america' },
  'tropical-caribbean': { countries: ['CO', 'VE', 'PA'], superRegion: 'latin-america' },
  'hispanic-caribbean': { countries: ['CU', 'DO', 'PR'], superRegion: 'latin-america' },
  'anglo-caribbean': {
    countries: ['JM', 'TT', 'BB', 'BS', 'GY', 'BZ', 'GD', 'LC', 'VC', 'AG', 'DM', 'KN'],
    superRegion: 'latin-america',
  },
  mexico: { countries: ['MX'], superRegion: 'latin-america' },
  'central-america': {
    countries: ['GT', 'SV', 'HN', 'NI', 'CR', 'HT'],
    superRegion: 'latin-america',
  },
  'north-america': { countries: ['US', 'CA'], superRegion: 'anglosphere' },
  'uk-ireland': { countries: ['GB', 'IE'], superRegion: 'anglosphere' },
  'oceania-anglo': { countries: ['AU', 'NZ'], superRegion: 'anglosphere' },
  iberia: { countries: ['ES', 'PT', 'AD'], superRegion: 'europe' },
  'france-benelux': { countries: ['FR', 'BE', 'NL', 'LU', 'MC'], superRegion: 'europe' },
  germanic: { countries: ['DE', 'AT', 'CH', 'LI'], superRegion: 'europe' },
  nordic: { countries: ['SE', 'NO', 'DK', 'FI', 'IS'], superRegion: 'europe' },
  italy: { countries: ['IT', 'SM', 'MT', 'VA'], superRegion: 'europe' },
  'eastern-europe': {
    countries: ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'UA', 'BY', 'MD', 'RU'],
    superRegion: 'europe',
  },
  balkans: {
    countries: ['RS', 'HR', 'BA', 'SI', 'MK', 'ME', 'AL', 'GR', 'CY'],
    superRegion: 'europe',
  },
  baltics: { countries: ['EE', 'LV', 'LT'], superRegion: 'europe' },
  'anatolia-caucasus': { countries: ['TR', 'AM', 'GE', 'AZ'], superRegion: 'mena' },
  'middle-east': {
    countries: ['SA', 'AE', 'IL', 'PS', 'LB', 'JO', 'SY', 'IQ', 'IR', 'KW', 'QA', 'BH', 'OM', 'YE'],
    superRegion: 'mena',
  },
  'north-africa': {
    countries: ['MA', 'DZ', 'TN', 'LY', 'EG', 'SD', 'EH', 'MR'],
    superRegion: 'mena',
  },
  'west-africa': {
    countries: [
      'NG',
      'GH',
      'SN',
      'ML',
      'CI',
      'BF',
      'GN',
      'BJ',
      'TG',
      'NE',
      'GM',
      'GW',
      'LR',
      'SL',
      'CV',
    ],
    superRegion: 'africa',
  },
  'east-africa': {
    countries: ['KE', 'TZ', 'UG', 'ET', 'ER', 'SO', 'RW', 'BI', 'DJ', 'SS', 'MG', 'MU', 'SC', 'KM'],
    superRegion: 'africa',
  },
  'central-africa': {
    countries: ['CD', 'CG', 'CM', 'GA', 'GQ', 'CF', 'TD', 'ST', 'AO'],
    superRegion: 'africa',
  },
  'southern-africa': {
    countries: ['ZA', 'ZW', 'ZM', 'MW', 'MZ', 'NA', 'BW', 'LS', 'SZ'],
    superRegion: 'africa',
  },
  'east-asia': {
    countries: ['JP', 'KR', 'KP', 'CN', 'TW', 'HK', 'MO', 'MN'],
    superRegion: 'asia',
  },
  'southeast-asia': {
    countries: ['TH', 'VN', 'PH', 'ID', 'MY', 'SG', 'KH', 'LA', 'MM', 'BN', 'TL'],
    superRegion: 'asia',
  },
  'south-asia': {
    countries: ['IN', 'PK', 'BD', 'LK', 'NP', 'BT', 'MV', 'AF'],
    superRegion: 'asia',
  },
  'central-asia': { countries: ['KZ', 'KG', 'TJ', 'TM', 'UZ'], superRegion: 'asia' },
  'pacific-islands': {
    countries: ['FJ', 'PG', 'WS', 'TO', 'SB', 'VU', 'KI', 'FM', 'MH', 'PW', 'NR', 'TV'],
    superRegion: 'asia',
  },
};

export type OriginRegion = keyof typeof ORIGIN_REGIONS;

const COUNTRY_TO_REGION: ReadonlyMap<string, OriginRegion> = new Map(
  Object.entries(ORIGIN_REGIONS).flatMap(([region, def]) =>
    def.countries.map((c) => [c, region as OriginRegion] as const),
  ),
);

export function regionOf(code: string): OriginRegion | null {
  return COUNTRY_TO_REGION.get(code) ?? null;
}

export function superRegionOf(code: string): OriginSuperRegion | null {
  const region = regionOf(code);
  return region ? ORIGIN_REGIONS[region]!.superRegion : null;
}

/**
 * Tiered origin closeness: same country 1.0 → same region 0.7 → same
 * super-region 0.4 → 0.1 floor (demote, never veto — two known-distant
 * origins are still both music). Null when either side is unknown/invalid,
 * so the radio axis is skipped rather than scored.
 */
export function originCloseness(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const ca = normalizeMbCountry(a);
  const cb = normalizeMbCountry(b);
  if (!ca || !cb) return null;
  if (ca === cb) return 1.0;
  const ra = regionOf(ca);
  const rb = regionOf(cb);
  if (ra && ra === rb) return 0.7;
  const sa = superRegionOf(ca);
  const sb = superRegionOf(cb);
  if (sa && sa === sb) return 0.4;
  return 0.1;
}

/** Max pairwise closeness over credited-artist country sets (genreSetCloseness shape). */
export function originSetCloseness(
  a: string[] | null | undefined,
  b: string[] | null | undefined,
): number | null {
  const la = (a ?? []).filter(Boolean);
  const lb = (b ?? []).filter(Boolean);
  if (la.length === 0 || lb.length === 0) return null;
  let best: number | null = null;
  for (const ca of la) {
    for (const cb of lb) {
      const c = originCloseness(ca, cb);
      if (c !== null && (best === null || c > best)) best = c;
      if (best === 1) return 1;
    }
  }
  return best;
}

/** Regional-indicator flag emoji, derived arithmetically; '' for invalid codes. */
export function countryFlagEmoji(code: string): string {
  const c = normalizeMbCountry(code);
  if (!c) return '';
  const A = 0x1f1e6;
  return (
    String.fromCodePoint(A + c.charCodeAt(0) - 65) + String.fromCodePoint(A + c.charCodeAt(1) - 65)
  );
}
