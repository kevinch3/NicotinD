import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * An unbounded container cannot fail alone. On 2026-09-14 the analysis sidecar
 * grew past 9.5 GB, took RAM *and* all 4 GB of swap with it, and the host spent
 * 3h42m thrashing: inbound-unreachable, never down, every health signal green.
 * A cgroup limit turns that into one container restarting — loud, logged, and
 * over in seconds.
 *
 * `memswap_limit` must EQUAL `mem_limit`, which is Docker's spelling of "this
 * container may not swap". Left unset, a container may use swap up to twice its
 * memory limit, and swap is precisely what let a container-sized bug become a
 * host-sized outage.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

type Service = { mem_limit?: string; memswap_limit?: string };
const services = (file: string): Record<string, Service> =>
  (parse(read(file)) as { services?: Record<string, Service> }).services ?? {};

/** `3g` / `512m` / `1024k` → bytes. Returns NaN for anything unparseable. */
const toBytes = (v: string | undefined): number => {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg])?$/i.exec(String(v ?? '').trim());
  if (!m) return Number.NaN;
  const scale = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase()] ?? 1;
  return Number(m[1]) * scale;
};

const GIB = 1024 ** 3;

/**
 * Every service's limits must sum to less than this. kpc has 31 GiB and also
 * runs a separate Immich stack plus host daemons, so the NicotinD stack cannot
 * claim the whole box — the headroom is the point, not a formality. Raising
 * this number is a deliberate act that should come with a look at the host.
 */
const STACK_BUDGET_BYTES = 18 * GIB;

describe('every container is bounded (docker-compose.yml)', () => {
  const all = services('docker-compose.yml');

  // Assert the denominator: a typo in the parser that yields {} must fail here
  // rather than vacuously "pass" every check below against an empty set.
  it('parses a plausible number of services', () => {
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(9);
  });

  it('declares mem_limit on every service', () => {
    const offenders = Object.entries(all)
      .filter(([, svc]) => !svc.mem_limit)
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('declares memswap_limit on every service', () => {
    const offenders = Object.entries(all)
      .filter(([, svc]) => !svc.memswap_limit)
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('forbids swap by setting memswap_limit equal to mem_limit', () => {
    const offenders = Object.entries(all)
      .filter(([, svc]) => toBytes(svc.mem_limit) !== toBytes(svc.memswap_limit))
      .map(([name, svc]) => `${name}: ${svc.mem_limit} vs ${svc.memswap_limit}`);
    expect(offenders).toEqual([]);
  });

  it('states every limit in a unit the parser understands', () => {
    const offenders = Object.entries(all)
      .filter(([, svc]) => !Number.isFinite(toBytes(svc.mem_limit)))
      .map(([name, svc]) => `${name}: ${svc.mem_limit}`);
    expect(offenders).toEqual([]);
  });

  it('fits the whole stack inside the host budget', () => {
    const total = Object.values(all).reduce((sum, svc) => sum + toBytes(svc.mem_limit), 0);
    expect(total).toBeLessThanOrEqual(STACK_BUDGET_BYTES);
  });
});

describe('the GPU overlay does not widen a limit behind the base file', () => {
  const base = services('docker-compose.yml');

  it('either omits mem_limit or keeps it no larger than the base', () => {
    const offenders = Object.entries(services('docker-compose.gpu.yml'))
      .filter(([name, svc]) => {
        if (!svc.mem_limit) return false; // inherits the base limit on merge
        return toBytes(svc.mem_limit) > toBytes(base[name]?.mem_limit);
      })
      .map(([name, svc]) => `${name}: ${svc.mem_limit} > ${base[name]?.mem_limit}`);
    expect(offenders).toEqual([]);
  });
});
