import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAddonProtocolSchema, serializeAddonProtocolSchema } from './addon-protocol-schema.js';

const committed = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'addon-protocol',
  'v1',
  'schema.json',
);

describe('published addon-protocol JSON Schema', () => {
  it('exposes each request/response DTO under $defs', () => {
    const schema = buildAddonProtocolSchema() as { $defs: Record<string, unknown> };
    expect(Object.keys(schema.$defs).sort()).toEqual([
      'AlbumSearchRequest',
      'JobRequest',
      'Manifest',
      'SearchRequest',
    ]);
  });

  it('the committed docs/addon-protocol/v1/schema.json is up to date', () => {
    // Drift guard: if this fails, run `bun run packages/core/src/scripts/gen-addon-schema.ts`.
    expect(readFileSync(committed, 'utf8')).toBe(serializeAddonProtocolSchema());
  });
});
