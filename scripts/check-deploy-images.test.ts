import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The deploy step used to pull a hardcoded service list (`pull nicotind
 * analysis`), so the three addon images and the pot-provider were never pulled.
 * `docker compose up -d` will not recreate a container whose image reference is
 * unchanged, so a rebuilt `:latest` addon kept serving the old bytes behind a
 * completely green deploy — issue #606, the #457 shape one layer down.
 *
 * These assert the *mechanism* (derive from compose), not a list, because a list
 * here would be the very second-place-to-forget the fix removes.
 */
const repoRoot = join(import.meta.dir, '..');
const deployYml = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
const composeYml = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');

/** The single ssh block that runs on the deploy host. */
function deployStep(): string {
  const start = deployYml.indexOf('Deploy via SSH');
  expect(start).toBeGreaterThan(-1);
  return deployYml.slice(start);
}

describe('deploy pulls every image we publish (issue #606)', () => {
  it('derives the pull list from the resolved compose config', () => {
    const step = deployStep();
    expect(step).toContain('docker compose config --images');
    expect(step).toContain('docker pull');
  });

  it('never hardcodes a service list on `docker compose pull`', () => {
    // `docker compose pull <svc> …` is the regression: it silently omits every
    // service nobody remembered to append.
    const hardcoded = /docker compose pull\s+[a-z]/.exec(deployStep());
    expect(hardcoded).toBeNull();
  });

  it('scopes the pull to our own registry, so a third-party outage cannot abort a release', () => {
    // linuxserver/lidarr + slskd/slskd are in compose but are not ours to
    // publish; pulling them would couple a release to their registries.
    expect(deployStep()).toContain('ghcr');
    expect(composeYml).toContain('linuxserver/lidarr');
    expect(composeYml).toContain('slskd/slskd');
  });

  it('still fails loudly on a bad pull rather than skipping it (#457)', () => {
    const step = deployStep();
    expect(step).not.toContain('--ignore-pull-failures');
    expect(step).toContain('set -e');
  });

  it('covers each addon image compose can run', () => {
    // Not a list the deploy must restate — a check that these images exist in
    // compose at all, so the derivation has something to find.
    for (const image of [
      'ghcr.io/kevinch3/nicotind-slskd-addon',
      'ghcr.io/kevinch3/nicotind-ytdlp-addon',
      'ghcr.io/kevinch3/nicotind-spotdl-addon',
      'ghcr.io/kevinch3/nicotind-pot-provider',
    ]) {
      expect(composeYml).toContain(image);
    }
  });
});
