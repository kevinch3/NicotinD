import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A freshly published npm version is the attack window: account-hijack waves ship a
 * malicious release and are usually pulled within hours. Both resolvers refuse a
 * version younger than the cooldown (docs/dependency-management.md "Release cooldown"),
 * and security fixes are exempt so a cooldown never delays a patch.
 */
const root = join(import.meta.dir, '..');
const MIN_COOLDOWN_SECONDS = 3 * 24 * 60 * 60;

describe('release cooldown', () => {
  it('bun refuses versions younger than the cooldown', () => {
    const bunfig = readFileSync(join(root, 'bunfig.toml'), 'utf8');
    const m = /^minimumReleaseAge\s*=\s*(\d+)/m.exec(bunfig);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(MIN_COOLDOWN_SECONDS);
  });

  it('renovate waits out the cooldown, except for vulnerability alerts', () => {
    const cfg = JSON.parse(readFileSync(join(root, 'renovate.json'), 'utf8'));
    expect(cfg.minimumReleaseAge).toMatch(/^([3-9]|\d{2,}) days?$/);
    expect(cfg.vulnerabilityAlerts.minimumReleaseAge).toBeNull();
  });
});
