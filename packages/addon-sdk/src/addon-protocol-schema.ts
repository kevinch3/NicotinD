import { z } from 'zod';
import {
  ADDON_PROTOCOL_VERSION,
  addonAlbumSearchRequestSchema,
  addonJobRequestSchema,
  addonManifestSchema,
  addonSearchRequestSchema,
} from './addon.js';

/**
 * The machine-checkable public contract for the acquisition addon protocol
 * (docs/superpowers/specs/2026-08-13-addon-ecosystem-security-contract-foundation-design.md
 * §2). Generated from the Zod DTOs so it can never drift from what core
 * actually validates — third-party addon authors validate their payloads
 * against `$defs`. `scripts/gen-addon-schema.ts` writes it to
 * docs/addon-protocol/v1/schema.json; a test asserts the committed file matches.
 */
export function buildAddonProtocolSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'NicotinD Acquisition Addon Protocol',
    protocolVersion: ADDON_PROTOCOL_VERSION,
    description:
      'Generated from the @nicotind/core Zod DTOs. Additive-only within a major; ' +
      'a breaking change bumps the major (see docs/addon-protocol/v1.md).',
    $defs: {
      Manifest: z.toJSONSchema(addonManifestSchema),
      SearchRequest: z.toJSONSchema(addonSearchRequestSchema),
      AlbumSearchRequest: z.toJSONSchema(addonAlbumSearchRequestSchema),
      JobRequest: z.toJSONSchema(addonJobRequestSchema),
    },
  };
}

/** Deterministic 2-space JSON so the committed file diffs cleanly on regen. */
export function serializeAddonProtocolSchema(): string {
  return `${JSON.stringify(buildAddonProtocolSchema(), null, 2)}\n`;
}
