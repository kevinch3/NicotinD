import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * #1009: a service mounting the `music` NAMED volume on a bind-mount host reads
 * an empty directory unless the example override carries a bind counterpart for
 * it. That is silent — the container starts, finds no files, reports nothing.
 *
 * Derived from the YAML, never a service list restated here: a list would be the
 * second place to forget, which is the defect this guards.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const read = (file: string) => readFileSync(resolve(repoRoot, file), 'utf-8');

const base = read('docker-compose.yml');
const gpu = read('docker-compose.gpu.yml');
const example = read('docker-compose.override.example.yml');

type Mount = { service: string; source: string; commented: boolean };

const SERVICE_KEY = /^ {2}([a-z][a-z0-9_-]*):\s*$/;
const MUSIC_MOUNT = /^\s*-\s+([^\s:]+):\/data\/music(?::[a-z]+)?\s*$/;

/** Drops one `# ` marker while keeping the indentation the comment stands in for. */
const uncomment = (line: string) => line.replace(/^(\s*)# ?/, '$1');

/** `- <source>:/data/music[:ro]` entries, tagged with the service they sit under. */
function musicMounts(yml: string, withCommented = false): Mount[] {
  const found: Mount[] = [];
  let service: string | null = null;
  let inServices = false;
  for (const raw of yml.split('\n')) {
    if (/^[a-z]/.test(raw)) inServices = raw.startsWith('services:');
    if (!inServices) continue;
    const line = uncomment(raw);
    const commented = line !== raw;
    if (commented && !withCommented) continue;
    const key = SERVICE_KEY.exec(line);
    if (key) {
      service = key[1]!;
      continue;
    }
    const mount = MUSIC_MOUNT.exec(line);
    if (mount && service) found.push({ service, source: mount[1]!, commented });
  }
  return found;
}

/** A source with no path separator is a named volume; anything else is a bind. */
const isNamedVolume = (source: string) => !source.includes('/');

const namedVolumeServices = [
  ...new Set(
    musicMounts(base + '\n' + gpu)
      .filter((m) => isNamedVolume(m.source))
      .map((m) => m.service),
  ),
];
const exampleMounts = musicMounts(example, true);
const baseServices = new Set(musicMounts(base).map((m) => m.service));
const exempt = new Map(
  [...example.matchAll(/^#\s*music-bind-exempt:\s*(\S+)\s+—\s*(\S.*)$/gm)].map((m) => [
    m[1]!,
    m[2]!,
  ]),
);

describe('every service on the music named volume has a bind counterpart (#1009)', () => {
  test('the service list is derived from compose, over every file that can mount music', () => {
    expect(namedVolumeServices.length).toBeGreaterThan(3);
    // The GPU overlay contributes none today: `separator` was its only music
    // mount and went with the ML removal (#1024). The overlay is still read
    // above so a future GPU service is covered the moment it is added — which
    // is the whole point of deriving the list instead of restating it.
    expect(musicMounts(gpu).length).toBe(0);
  });

  test('each one has a bind counterpart, or a documented exemption', () => {
    const missing = namedVolumeServices.filter(
      (service) =>
        !exempt.has(service) &&
        // A base-defined service must carry a LIVE block: commenting one out
        // reinstates the empty mount just as silently as deleting it. Only an
        // overlay-only service is allowed the commented form (see below).
        !exampleMounts.some(
          (m) =>
            m.service === service &&
            !isNamedVolume(m.source) &&
            (!m.commented || !baseServices.has(service)),
        ),
    );
    expect(missing).toEqual([]);
  });

  test('a counterpart never re-states the named volume it is meant to replace', () => {
    // Compose merges volumes by container target, last file wins — an override
    // entry that names `music` again resolves back to the empty named volume.
    expect(exampleMounts.filter((m) => isNamedVolume(m.source))).toEqual([]);
  });
});

describe('the example override stays valid against the base file alone', () => {
  // ci.yml runs `docker compose -f docker-compose.yml -f
  // docker-compose.override.example.yml config -q`. A live block for a service
  // the base file does not define fails that gate ("has neither an image nor a
  // build context"), which is why an overlay-only service is guided in comments.

  test('a live counterpart exists only for a service docker-compose.yml defines', () => {
    const live = exampleMounts.filter((m) => !m.commented).map((m) => m.service);
    expect(live.filter((service) => !baseServices.has(service))).toEqual([]);
  });

  test('an overlay-only service is covered by commented guidance instead', () => {
    const overlayOnly = namedVolumeServices.filter((service) => !baseServices.has(service));
    // Currently empty (see above), so this loop asserts nothing today. Stated
    // rather than guarded by a `> 0` denominator check, because that check
    // would now fail for the honest reason and the fix would be to weaken it —
    // the exact move docs/quality-gates.md forbids. The rule still runs the
    // instant an overlay defines its own music-mounted service.
    expect(overlayOnly).toEqual([]);
    for (const service of overlayOnly) {
      const covered = exampleMounts.some((m) => m.service === service && m.commented);
      expect({ service, covered: covered || exempt.has(service) }).toEqual({
        service,
        covered: true,
      });
    }
  });
});

describe('documented GPU invocations put the overlay before the override', () => {
  // Scoped to commands naming BOTH files: other overlays (streaming-only) compose
  // with the override in either order, and are none of this test's business.
  const docs = readdirSync(resolve(repoRoot, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`);
  const sources = ['docker-compose.gpu.yml', 'docker-compose.override.example.yml', ...docs];

  const invocations = sources.flatMap((file) =>
    read(file)
      .replace(/\\\n\s*/g, ' ') // shell line continuations
      .split('\n')
      .filter((l) => l.includes('docker-compose.gpu.yml') && l.includes('docker-compose.override'))
      .map((line) => ({ file, line: line.trim() })),
  );

  test('there is at least one such invocation to check', () => {
    expect(invocations.length).toBeGreaterThan(0);
  });

  test('none of them lists the override first', () => {
    const wrong = invocations.filter(
      ({ line }) =>
        line.indexOf('docker-compose.override') < line.indexOf('docker-compose.gpu.yml'),
    );
    expect(wrong).toEqual([]);
  });
});
