import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../../../db.js';
import { PluginRegistry } from '../../plugins/registry.js';
import { registerBundledAddons } from './registry.js';

describe('registerBundledAddons', () => {
  it('clears staging a previous process left, and nothing beside it', () => {
    const base = join(tmpdir(), `bundled-reg-${process.pid}-${Date.now()}`);
    const leftover = join(base, 'bundled-archive', 'abc123', 'A', 'B', 'one.mp3.part');
    const neighbour = join(base, 'other-addon', 'keep.flac');
    for (const f of [leftover, neighbour]) {
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, 'x');
    }
    const db = new Database(':memory:');
    applySchema(db);
    const registry = new PluginRegistry({ db, dataDir: join(base, 'data') });
    registerBundledAddons(registry, { stagingDir: base });
    expect(existsSync(join(base, 'bundled-archive'))).toBe(false);
    expect(existsSync(neighbour)).toBe(true);
    expect(registry.get('bundled-archive')).toBeDefined();
  });
});
