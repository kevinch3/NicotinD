#!/usr/bin/env bun
// Regenerate the published addon-protocol JSON Schema from the Zod DTOs.
// Run: bun run packages/core/src/scripts/gen-addon-schema.ts
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeAddonProtocolSchema } from '../addon-protocol-schema.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const out = join(repoRoot, 'docs', 'addon-protocol', 'v1', 'schema.json');
writeFileSync(out, serializeAddonProtocolSchema());
console.log(`wrote ${out}`);
