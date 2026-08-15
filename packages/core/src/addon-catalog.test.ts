import { describe, expect, it } from 'bun:test';
import {
  ADDON_CATALOG,
  catalogEntry,
  catalogInstallState,
  renderComposeSnippet,
  type AddonCatalogEntry,
} from './addon-catalog.js';

describe('ADDON_CATALOG', () => {
  it('has unique ids and every non-builtin carries an addon service', () => {
    const ids = ADDON_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of ADDON_CATALOG) {
      if (e.builtin) expect(e.composeServices).toHaveLength(0);
      else expect(e.composeServices.length).toBeGreaterThan(0);
    }
  });

  it('every non-builtin has exactly one token-bearing service (the addon itself)', () => {
    for (const e of ADDON_CATALOG.filter((x) => !x.builtin)) {
      const tokenServices = e.composeServices.filter((s) => s.tokenEnvVar);
      expect(tokenServices).toHaveLength(1);
    }
  });

  it("the addon service's name matches the host in addonUrl", () => {
    for (const e of ADDON_CATALOG.filter((x) => !x.builtin)) {
      const addonSvc = e.composeServices.find((s) => s.tokenEnvVar)!;
      // addonUrl is http://<service>:<port>
      expect(e.addonUrl).toContain(`//${addonSvc.name}:`);
    }
  });
});

describe('catalogEntry', () => {
  it('finds by id, undefined otherwise', () => {
    expect(catalogEntry('ytdlp-addon')?.name).toBe('yt-dlp');
    expect(catalogEntry('nope')).toBeUndefined();
  });
});

describe('catalogInstallState', () => {
  const ytdlp = catalogEntry('ytdlp-addon')!;
  const archive = catalogEntry('archive')!;

  it('builtin entries are always builtin regardless of registrations', () => {
    expect(catalogInstallState(archive, [])).toBe('builtin');
    expect(catalogInstallState(archive, [{ id: 'archive', status: 'active' }])).toBe('builtin');
  });

  it('available when no matching registration', () => {
    expect(catalogInstallState(ytdlp, [])).toBe('available');
    expect(catalogInstallState(ytdlp, [{ id: 'other', status: 'active' }])).toBe('available');
  });

  it('pending vs installed follows the registration status', () => {
    expect(catalogInstallState(ytdlp, [{ id: 'ytdlp-addon', status: 'pending' }])).toBe('pending');
    expect(catalogInstallState(ytdlp, [{ id: 'ytdlp-addon', status: 'active' }])).toBe('installed');
    // Missing status defaults to installed (legacy rows predate the column).
    expect(catalogInstallState(ytdlp, [{ id: 'ytdlp-addon' }])).toBe('installed');
  });
});

describe('renderComposeSnippet', () => {
  const TOKEN = 'tok_deadbeef1234';

  it('bakes the minted token into the addon service env, never change-me', () => {
    const snip = renderComposeSnippet(catalogEntry('ytdlp-addon')!, TOKEN);
    expect(snip.services).toContain(`YTDLP_ADDON_TOKEN: ${TOKEN}`);
    expect(snip.full).not.toContain('change-me');
  });

  it('emits the pot-provider companion for ytdlp/spotdl (network_mode share)', () => {
    const snip = renderComposeSnippet(catalogEntry('ytdlp-addon')!, TOKEN);
    expect(snip.services).toContain('ytdlp-pot-provider:');
    expect(snip.services).toContain('network_mode: "service:ytdlp-addon"');
    expect(snip.services).toContain('runtime: runc');
    // The companion must NOT carry the token.
    const companionBlock = snip.services.split('ytdlp-pot-provider:')[1]!;
    expect(companionBlock).not.toContain(TOKEN);
  });

  it('surfaces the addon data volume + the profile up command', () => {
    const snip = renderComposeSnippet(catalogEntry('spotdl-addon')!, TOKEN);
    expect(snip.volumes).toEqual(['spotdl-addon-data']);
    expect(snip.command).toBe('docker compose --profile spotdl-addon up -d');
    expect(snip.full).toContain('spotdl-addon-data:');
    expect(snip.full).toContain(snip.command);
  });

  it('renders slskd depends_on with a service_started condition', () => {
    const snip = renderComposeSnippet(catalogEntry('slskd-addon')!, TOKEN);
    expect(snip.services).toContain('depends_on:');
    expect(snip.services).toContain('slskd:');
    expect(snip.services).toContain('condition: service_started');
    expect(snip.services).toContain('music:/data/music:ro');
  });

  it('produces an empty snippet for a builtin entry', () => {
    const snip = renderComposeSnippet(catalogEntry('archive')!, TOKEN);
    expect(snip.services).toBe('');
    expect(snip.volumes).toEqual([]);
    expect(snip.full).toBe('');
  });

  it('is valid indentation: every service line is 2-space indented under services', () => {
    const entry: AddonCatalogEntry = catalogEntry('ytdlp-addon')!;
    const snip = renderComposeSnippet(entry, TOKEN);
    // Service headers sit at 2 spaces; keys at 4.
    expect(snip.services).toMatch(/^ {2}ytdlp-addon:$/m);
    expect(snip.services).toMatch(/^ {4}image: /m);
  });
});
