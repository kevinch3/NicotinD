// Curated addon catalog (issue #517) — the source of truth for the Extensions
// "Available add-ons" marketplace. Deliberately a short, vetted, in-repo list
// (NOT an open/user-submitted registry) so the compliance posture stays
// curated + consent-gated. Each entry carries enough to render an install card
// and generate a paste-able docker-compose snippet with a core-minted token.
//
// The entry `id` MUST equal the addon manifest id it registers as — that
// equality is what lets `catalogInstallState` diff the catalog against the live
// `addon_registrations` rows, and what the pending→active promoter checks before
// trusting a fetched manifest.

// why: import from the manifest module, not the plugin barrel — the barrel
// re-exports capabilities/context, which drag the logger into the web's
// (stricter) typecheck graph. This module needs only the two manifest types.
import type { PluginCapability, PluginKind } from './plugin/manifest.js';

/** Where an addon sits relative to what's already installed. */
export type AddonCatalogInstallState =
  | 'builtin' // first-party bundled (archive) — always present, not installable
  | 'installed' // a live `addon_registrations` row exists (status active)
  | 'pending' // registered but its container isn't reachable yet (awaiting manifest)
  | 'available'; // in the catalog, not yet installed

/**
 * One docker-compose service the snippet emits. An addon is usually one service
 * (the addon itself); yt-dlp/spotdl additionally emit their `pot-provider`
 * companion, which shares the addon's network namespace. Fields mirror the
 * real blocks in `docker-compose.yml` so a generated snippet reads identically
 * to a hand-written one.
 */
export interface ComposeServiceTemplate {
  /** Service name in the generated compose (e.g. 'ytdlp-addon'). */
  name: string;
  image: string;
  /** compose `profiles:` entry — the opt-in gate. */
  profile: string;
  /**
   * When set, this service's environment gets `<tokenEnvVar>: <minted token>`.
   * Only the addon service carries it; companions (pot-provider) do not.
   */
  tokenEnvVar?: string;
  /**
   * Extra `environment:` entries rendered verbatim (KEY: value). Used for the
   * deployment-specific knobs core can't know (slskd creds/dirs) and optional
   * ones (Spotify client id/secret). Values may be `${VAR:-default}` refs.
   */
  extraEnv?: Record<string, string>;
  /** Named volumes to mount, e.g. ['ytdlp-addon-data:/data']. */
  volumes?: string[];
  /** compose `networks:` entries (mutually exclusive with networkMode). */
  networks?: string[];
  /** compose `network_mode:` — the pot-provider companion shares the addon ns. */
  networkMode?: string;
  /** `runtime:` override (pot-provider uses runc). */
  runtime?: string;
  /** depends_on services (rendered with `condition: service_started`). */
  dependsOn?: string[];
  /** restart policy; defaults to `unless-stopped`. */
  restart?: string;
}

export interface AddonCatalogEntry {
  /** Stable id — MUST equal the addon manifest id it registers as. */
  id: string;
  name: string;
  description: string;
  kind: PluginKind;
  /**
   * Informational capability chips for the card. The authoritative set comes
   * from the fetched manifest once installed; this is only for the pre-install
   * card.
   */
  capabilities: PluginCapability[];
  /** One-line risk/compliance summary shown on the card. */
  risk: string;
  /**
   * The docker-internal URL core polls + registers under. Matches the addon
   * service name + port in the generated snippet.
   */
  addonUrl: string;
  /** Link to the addon's repo/README (the "learn more" target). */
  docsUrl?: string;
  /** First-party bundled addon (archive) — present in-process, not installable. */
  builtin?: boolean;
  /** Compose services to emit (addon + optional companions). Empty for builtin. */
  composeServices: ComposeServiceTemplate[];
  /**
   * Top-level named `volumes:` the snippet must declare (the addon's data
   * volume). Shared volumes already in the base compose (e.g. `music`) are not
   * repeated here.
   */
  volumes?: string[];
}

/**
 * The curated list. Ordered most-used first. Images/ports/profiles mirror
 * `docker-compose.yml`; keep them in sync when an addon's block changes.
 */
export const ADDON_CATALOG: readonly AddonCatalogEntry[] = [
  {
    id: 'slskd-addon',
    name: 'Soulseek (slskd)',
    description:
      'Search + download music from the Soulseek P2P network. The primary acquisition source.',
    kind: 'acquisition',
    capabilities: ['search', 'browse', 'download'],
    risk: 'Peer-to-peer downloads. You are responsible for what you acquire.',
    addonUrl: 'http://slskd-addon:8585',
    docsUrl: 'https://github.com/kevinch3/nicotind-slskd-addon',
    volumes: ['slskd-addon-data'],
    composeServices: [
      {
        name: 'slskd-addon',
        image: 'ghcr.io/kevinch3/nicotind-slskd-addon:latest',
        profile: 'slskd-addon',
        tokenEnvVar: 'SLSKD_ADDON_TOKEN',
        extraEnv: {
          SLSKD_ADDON_SLSKD_URL: 'http://slskd:5030',
          SLSKD_ADDON_SLSKD_USERNAME: 'slskd',
          SLSKD_ADDON_SLSKD_PASSWORD: 'slskd',
          SLSKD_ADDON_DOWNLOADS_DIR: '/data/music',
          SLSKD_ADDON_MUSIC_DIR: '/data/music',
        },
        volumes: ['slskd-addon-data:/data', 'music:/data/music:ro'],
        dependsOn: ['slskd'],
        networks: ['internal'],
      },
    ],
  },
  {
    id: 'ytdlp-addon',
    name: 'yt-dlp',
    description:
      'Resolve audio from any yt-dlp-supported URL: YouTube, SoundCloud, Bandcamp, and more.',
    kind: 'acquisition',
    capabilities: ['resolve', 'download'],
    risk: 'Downloads from third-party sites. Respect each source’s terms of use.',
    addonUrl: 'http://ytdlp-addon:8586',
    docsUrl: 'https://github.com/kevinch3/nicotind-ytdlp-addon',
    volumes: ['ytdlp-addon-data'],
    composeServices: [
      {
        name: 'ytdlp-addon',
        image: 'ghcr.io/kevinch3/nicotind-ytdlp-addon:latest',
        profile: 'ytdlp-addon',
        tokenEnvVar: 'YTDLP_ADDON_TOKEN',
        volumes: ['ytdlp-addon-data:/data'],
        networks: ['internal'],
      },
      {
        name: 'ytdlp-pot-provider',
        image: 'ghcr.io/kevinch3/nicotind-pot-provider:${NICOTIND_IMAGE_TAG:-release}',
        profile: 'ytdlp-addon',
        runtime: 'runc',
        networkMode: 'service:ytdlp-addon',
        dependsOn: ['ytdlp-addon'],
      },
    ],
  },
  {
    id: 'spotdl-addon',
    name: 'spotDL',
    description: 'Resolve Spotify track / album / playlist URLs (downloads the audio via spotDL).',
    kind: 'acquisition',
    capabilities: ['resolve', 'download'],
    risk: 'Downloads from third-party sites. Respect each source’s terms of use.',
    addonUrl: 'http://spotdl-addon:8587',
    docsUrl: 'https://github.com/kevinch3/nicotind-spotdl-addon',
    volumes: ['spotdl-addon-data'],
    composeServices: [
      {
        name: 'spotdl-addon',
        image: 'ghcr.io/kevinch3/nicotind-spotdl-addon:latest',
        profile: 'spotdl-addon',
        tokenEnvVar: 'SPOTDL_ADDON_TOKEN',
        extraEnv: {
          SPOTDL_ADDON_CLIENT_ID: '${SPOTIFY_CLIENT_ID:-}',
          SPOTDL_ADDON_CLIENT_SECRET: '${SPOTIFY_CLIENT_SECRET:-}',
        },
        volumes: ['spotdl-addon-data:/data'],
        networks: ['internal'],
      },
      {
        name: 'spotdl-pot-provider',
        image: 'ghcr.io/kevinch3/nicotind-pot-provider:${NICOTIND_IMAGE_TAG:-release}',
        profile: 'spotdl-addon',
        runtime: 'runc',
        networkMode: 'service:spotdl-addon',
        dependsOn: ['spotdl-addon'],
      },
    ],
  },
  {
    id: 'archive',
    name: 'Internet Archive',
    description: 'Fetch freely-licensed audio from archive.org URLs. Bundled — no setup required.',
    kind: 'acquisition',
    capabilities: ['resolve', 'download'],
    risk: 'Public-domain / freely-licensed material from archive.org.',
    addonUrl: 'local:archive',
    docsUrl: 'https://github.com/kevinch3/NicotinD/blob/master/docs/acquisition-addon-protocol.md',
    builtin: true,
    composeServices: [],
  },
];

/** Look up a catalog entry by id. */
export function catalogEntry(id: string): AddonCatalogEntry | undefined {
  return ADDON_CATALOG.find((e) => e.id === id);
}

/** The minimal registration shape `catalogInstallState` needs to diff against. */
export interface CatalogRegistrationView {
  id: string;
  /** 'active' once the manifest was fetched + the plugin registered; 'pending' before. */
  status?: 'active' | 'pending';
}

/**
 * Where a catalog entry stands relative to the live registrations. Pure so both
 * the API route and web can share the verdict.
 */
export function catalogInstallState(
  entry: AddonCatalogEntry,
  registrations: readonly CatalogRegistrationView[],
): AddonCatalogInstallState {
  if (entry.builtin) return 'builtin';
  const reg = registrations.find((r) => r.id === entry.id);
  if (!reg) return 'available';
  return reg.status === 'pending' ? 'pending' : 'installed';
}

/** The generated snippet, split so the UI can render + copy each part. */
export interface ComposeSnippet {
  /** The `services:` block body (2-space indented, ready to paste under `services:`). */
  services: string;
  /** Named volumes to add under top-level `volumes:`. */
  volumes: string[];
  /** The command to bring the profile up. */
  command: string;
  /** The whole thing as one copy-paste block (services + volumes note + command). */
  full: string;
}

function indentEnv(env: Record<string, string>, pad: string): string[] {
  return Object.entries(env).map(([k, v]) => `${pad}${k}: ${v}`);
}

function renderService(svc: ComposeServiceTemplate, token: string): string {
  const lines: string[] = [`  ${svc.name}:`, `    image: ${svc.image}`];
  lines.push(`    profiles: ["${svc.profile}"]`);
  if (svc.runtime) lines.push(`    runtime: ${svc.runtime}`);
  if (svc.networkMode) lines.push(`    network_mode: "${svc.networkMode}"`);

  const env: Record<string, string> = {};
  if (svc.tokenEnvVar) env[svc.tokenEnvVar] = token;
  Object.assign(env, svc.extraEnv ?? {});
  if (Object.keys(env).length) {
    lines.push('    environment:');
    lines.push(...indentEnv(env, '      '));
  }
  if (svc.volumes?.length) {
    lines.push('    volumes:');
    lines.push(...svc.volumes.map((v) => `      - ${v}`));
  }
  if (svc.networks?.length) {
    lines.push('    networks:');
    lines.push(...svc.networks.map((n) => `      - ${n}`));
  }
  if (svc.dependsOn?.length) {
    lines.push('    depends_on:');
    for (const dep of svc.dependsOn) {
      lines.push(`      ${dep}:`);
      lines.push('        condition: service_started');
    }
  }
  lines.push(`    restart: ${svc.restart ?? 'unless-stopped'}`);
  return lines.join('\n');
}

/**
 * Render the docker-compose snippet an admin pastes to bring an addon up, with
 * the (core-minted) `token` baked into the addon service's token env — never a
 * `change-me` placeholder. The output mirrors the hand-written blocks in
 * `docker-compose.yml` so it reads as native.
 *
 * Builtin entries (archive) have no services and produce an empty snippet.
 */
export function renderComposeSnippet(entry: AddonCatalogEntry, token: string): ComposeSnippet {
  const services = entry.composeServices.map((s) => renderService(s, token)).join('\n\n');
  const volumes = entry.volumes ?? [];
  const profile = entry.composeServices[0]?.profile ?? entry.id;
  const command = `docker compose --profile ${profile} up -d`;

  const parts: string[] = [];
  if (services) {
    parts.push('# Add under the top-level `services:` key:');
    parts.push(services);
  }
  if (volumes.length) {
    parts.push('');
    parts.push('# Add under the top-level `volumes:` key:');
    parts.push(volumes.map((v) => `  ${v}:`).join('\n'));
  }
  if (services) {
    parts.push('');
    parts.push('# Then bring it up:');
    parts.push(command);
  }
  return { services, volumes, command, full: parts.join('\n') };
}
