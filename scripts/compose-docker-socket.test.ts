import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * #1015: the Docker socket is host-root-equivalent (`:ro` does not help — the
 * API is read-write over it). The published image is public, so the default
 * compose file is what strangers run; the admin log viewer is an opt-in in
 * docker-compose.override.example.yml, and only there.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

type Service = { volumes?: (string | { source?: string })[]; group_add?: unknown[] };
const services = (file: string): Record<string, Service> =>
  (parse(read(file)) as { services?: Record<string, Service> }).services ?? {};

const mountsSocket = (svc: Service) =>
  (svc.volumes ?? []).some((v) =>
    (typeof v === 'string' ? v.split(':')[0] : v.source)?.endsWith('docker.sock'),
  );

describe('the Docker socket is opt-in, never a default (#1015)', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.gpu.yml']) {
    it(`${file} mounts it into no service`, () => {
      const offenders = Object.entries(services(file))
        .filter(([, svc]) => mountsSocket(svc))
        .map(([name]) => name);
      expect(offenders).toEqual([]);
    });
  }

  it('docker-compose.yml grants no service the docker group it existed for', () => {
    const grouped = Object.entries(services('docker-compose.yml'))
      .filter(([, svc]) => (svc.group_add ?? []).length > 0)
      .map(([name]) => name);
    expect(grouped).toEqual([]);
  });

  it('the override example still offers it, commented out', () => {
    const example = read('docker-compose.override.example.yml');
    expect(example).toMatch(/^\s*#\s*-\s*\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/m);
    expect(Object.values(services('docker-compose.override.example.yml')).some(mountsSocket)).toBe(
      false,
    );
  });
});
