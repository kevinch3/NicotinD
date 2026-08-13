import { ADDON_PROTOCOL_VERSION, type AddonManifest } from '@nicotind/addon-sdk';

const DISCLAIMER =
  'Soulseek is a peer-to-peer file-sharing network. By enabling it you take ' +
  'responsibility for ensuring your use complies with copyright and other laws ' +
  'in your jurisdiction. This addon does not host, index, or distribute any ' +
  'content — it only drives the slskd client you connect.';

export const ADDON_VERSION = '0.1.0';

/** The addon's self-description, served unauthenticated at GET /addon/v1/manifest. */
export function buildManifest(): AddonManifest {
  return {
    id: 'slskd',
    name: 'Soulseek (slskd addon)',
    description:
      'Acquires music from the Soulseek P2P network via slskd — search, album hunt ' +
      'with per-peer fallback, and per-track retry — served over the acquisition addon protocol.',
    version: ADDON_VERSION,
    protocolVersion: ADDON_PROTOCOL_VERSION,
    kind: 'acquisition',
    capabilities: ['search', 'browse', 'download'],
    configFields: [
      { key: 'soulseekUsername', label: 'Soulseek username', type: 'text' },
      { key: 'soulseekPassword', label: 'Soulseek password', type: 'password' },
    ],
    statusFields: [
      { key: 'connection', label: 'Connection' },
      { key: 'downloadSpeed', label: 'Download speed' },
      { key: 'uploadSpeed', label: 'Upload speed' },
      { key: 'downloading', label: 'Downloading' },
      { key: 'queued', label: 'Queued' },
    ],
    compliance: { disclaimer: DISCLAIMER, requiresConsent: true },
  };
}
