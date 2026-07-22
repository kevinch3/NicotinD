/**
 * Music licence / rights vocabulary — the one closed vocabulary shared by the
 * API (scanner, tag seam, filter SQL, enrichment) and the web UI (track-info
 * editor, filter panel). Browser-safe: types + pure functions only, no IO.
 *
 * Canonical machine codes are stored in `library_songs.licence` and travel in
 * the `Song.licence` DTO + the `licence` filter param. `unknown` is a UI/filter
 * bucket only — a track with no known licence is stored as SQL NULL (never the
 * literal string "unknown"), so the background enrichment task (which fills
 * `WHERE licence IS NULL`) keeps trying to resolve it. `normalizeLicence`
 * therefore maps only *positive* identifications and returns null for
 * unrecognised / "unknown" input; it never guesses `all-rights-reserved`
 * (a bare copyright notice is not a licence signal) unless the text says so.
 */

/** Canonical licence codes, most-open → most-closed. */
export const LICENCE_VOCAB = [
  'public-domain',
  'cc0',
  'cc-by',
  'cc-by-sa',
  'cc-by-nc',
  'cc-by-nd',
  'cc-by-nc-sa',
  'cc-by-nc-nd',
  'all-rights-reserved',
  'unknown',
] as const;
export type LicenceCode = (typeof LICENCE_VOCAB)[number];

/** Human-readable label for each code (menus, track-info row). */
export const LICENCE_LABELS: Record<LicenceCode, string> = {
  'public-domain': 'Public Domain',
  cc0: 'CC0 (Public Domain Dedication)',
  'cc-by': 'CC BY',
  'cc-by-sa': 'CC BY-SA',
  'cc-by-nc': 'CC BY-NC',
  'cc-by-nd': 'CC BY-ND',
  'cc-by-nc-sa': 'CC BY-NC-SA',
  'cc-by-nc-nd': 'CC BY-NC-ND',
  'all-rights-reserved': 'All Rights Reserved',
  unknown: 'Unknown',
};

/** Compact badge for listings (e.g. a track-row chip). */
export const LICENCE_BADGES: Record<LicenceCode, string> = {
  'public-domain': 'PD',
  cc0: 'CC0',
  'cc-by': 'CC BY',
  'cc-by-sa': 'CC BY-SA',
  'cc-by-nc': 'CC BY-NC',
  'cc-by-nd': 'CC BY-ND',
  'cc-by-nc-sa': 'BY-NC-SA',
  'cc-by-nc-nd': 'BY-NC-ND',
  'all-rights-reserved': '©',
  unknown: '?',
};

/** True when `v` is one of the canonical codes. */
export function isLicenceCode(v: unknown): v is LicenceCode {
  return typeof v === 'string' && (LICENCE_VOCAB as readonly string[]).includes(v);
}

/** A track is free-to-use (public domain / CC without extra restriction axes we care about). */
export function isFreeLicence(code: string | undefined | null): boolean {
  return code === 'public-domain' || code === 'cc0';
}

/**
 * Build a CC code from its clause tokens (`by`, `sa`, `nc`, `nd`). Every
 * standard CC 4.0 licence carries BY; without it we can't name a flavour, so
 * return null (CC0 / public-domain are handled by the caller before this).
 */
function ccClausesToCode(tokens: string[]): LicenceCode | null {
  const set = new Set(tokens.map((t) => t.trim().toLowerCase()).filter(Boolean));
  if (set.has('zero')) return 'cc0';
  if (!set.has('by')) return null;
  const nc = set.has('nc');
  const sa = set.has('sa');
  const nd = set.has('nd');
  if (nc && sa) return 'cc-by-nc-sa';
  if (nc && nd) return 'cc-by-nc-nd';
  if (nc) return 'cc-by-nc';
  if (sa) return 'cc-by-sa';
  if (nd) return 'cc-by-nd';
  return 'cc-by';
}

/**
 * Map a free-text / URL rights string (from a file tag's LICENSE/COPYRIGHT/WCOP
 * frame, or a MusicBrainz `license` url-relation) to a canonical code, or null
 * when nothing is confidently recognised. Positive identifications only — a
 * bare "© 2020 Artist" copyright yields null, not `all-rights-reserved`.
 */
export function normalizeLicence(raw: string | undefined | null): LicenceCode | null {
  if (raw == null) return null;
  const low = String(raw).trim().toLowerCase();
  if (!low) return null;
  // Hyphens/underscores → spaces so "public-domain" and "share-alike" read the
  // same as their spaced spellings in the substring checks below.
  const spaced = low.replace(/[-_]+/g, ' ');

  // 1. Creative Commons / public-domain URLs — the most reliable signal.
  const licUrl = low.match(/creativecommons\.org\/licenses\/([a-z][a-z-]*)/);
  if (licUrl?.[1]) {
    const code = ccClausesToCode(licUrl[1].split('-'));
    if (code) return code;
  }
  if (/creativecommons\.org\/publicdomain\/zero/.test(low)) return 'cc0';
  if (/creativecommons\.org\/publicdomain\/mark/.test(low)) return 'public-domain';

  // 2. CC0 / public-domain dedication (text).
  if (/\bcc0\b/.test(low) || spaced.includes('creative commons zero') ||
      spaced.includes('public domain dedication')) {
    return 'cc0';
  }

  // 3. Public domain (text / PD mark).
  if (spaced.includes('public domain') || /\bpdm\b/.test(low)) return 'public-domain';

  // 4. A Creative Commons licence named in text — assemble from its clauses.
  // Test against `spaced` so underscore-joined forms ("cc_by_nc_sa") read the
  // same as spaced/hyphenated ones.
  const looksCc = /\bcc\b/.test(spaced) || spaced.includes('creative commons');
  if (looksCc) {
    const tokens: string[] = [];
    if (/\bby\b/.test(spaced) || spaced.includes('attribution')) tokens.push('by');
    if (/\bsa\b/.test(spaced) || spaced.includes('sharealike') || spaced.includes('share alike'))
      tokens.push('sa');
    if (/\bnc\b/.test(spaced) || spaced.includes('noncommercial') || spaced.includes('non commercial'))
      tokens.push('nc');
    if (/\bnd\b/.test(spaced) || spaced.includes('noderivs') || spaced.includes('no derivatives') ||
        spaced.includes('noderivatives'))
      tokens.push('nd');
    const code = ccClausesToCode(tokens);
    if (code) return code;
  }

  // 5. All rights reserved — only when explicitly stated.
  if (spaced.includes('all rights reserved')) return 'all-rights-reserved';

  return null;
}
