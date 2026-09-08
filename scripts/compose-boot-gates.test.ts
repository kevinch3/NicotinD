import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

type DependsOn = Record<string, { condition?: string }>;
type Service = { depends_on?: DependsOn | string[] };

const services = (file: string): Record<string, Service> =>
  (parse(readFileSync(join(repoRoot, file), 'utf8')) as { services?: Record<string, Service> })
    .services ?? {};

const healthGates = (svc: Service): string[] =>
  Array.isArray(svc.depends_on) || !svc.depends_on
    ? []
    : Object.entries(svc.depends_on)
        .filter(([, dep]) => dep?.condition === 'service_healthy')
        .map(([name]) => name);

describe('docker-compose boot gates', () => {
  // A `service_healthy` gate does not just order startup: compose refuses to
  // START the dependent container while the dependency is unhealthy, and leaves
  // it in `created` with no logs and no restart. On 2026-09-08 an unhealthy
  // Lidarr (its SQLite could not write — the disk was full) kept the API down
  // through a deploy that otherwise had nothing wrong with it (#1019).
  it('never gates a service on the HEALTH of one the app degrades without', () => {
    const gated = Object.entries(services('docker-compose.yml'))
      .map(([name, svc]) => [name, healthGates(svc)] as const)
      .filter(([, deps]) => deps.length > 0);

    expect(gated).toEqual([]);
  });

  // Ordering is still wanted — the dependency's container and DNS name should
  // exist first — so the entries themselves must not simply be deleted.
  it('keeps the ordering it has, as service_started', () => {
    const conditions = Object.values(services('docker-compose.yml'))
      .flatMap((svc) =>
        Array.isArray(svc.depends_on) || !svc.depends_on ? [] : Object.values(svc.depends_on),
      )
      .map((dep) => dep?.condition);

    expect(conditions.length).toBeGreaterThan(0);
    expect(new Set(conditions)).toEqual(new Set(['service_started']));
  });
});
