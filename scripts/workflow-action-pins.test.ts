import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `uses:` is pinned to a full commit SHA, first-party `actions/*` included.
 * A tag (even a major like `v7`) is mutable: the May 2026 actions-cool/issues-helper
 * compromise repointed existing tags at an imposter commit that stole CI secrets.
 * The trailing `# vN` comment is what Renovate (`helpers:pinGitHubActionDigests`)
 * reads to keep the SHA current. Local (`./`) and `docker://` refs are not tags.
 */
const dir = join(import.meta.dir, '..', '.github', 'workflows');

const uses = readdirSync(dir)
  .filter((f) => f.endsWith('.yml'))
  .flatMap((file) =>
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .map((line, i) => ({
        where: `${file}:${i + 1}`,
        m: /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line),
      }))
      .filter((l) => l.m)
      .map((l) => ({ where: l.where, ref: l.m![1], rest: l.m![2] })),
  )
  .filter((u) => !u.ref.startsWith('./') && !u.ref.startsWith('docker://'));

describe('workflow action pins', () => {
  it('finds the references it is meant to police', () => {
    expect(uses.length).toBeGreaterThan(50);
  });

  it('pins every action to a full commit SHA', () => {
    const loose = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u.ref));
    expect(loose.map((u) => `${u.where} ${u.ref}`)).toEqual([]);
  });

  it('keeps a version comment so Renovate can move the pin', () => {
    const bare = uses.filter((u) => !/#\s*v?\d/.test(u.rest));
    expect(bare.map((u) => `${u.where} ${u.ref}`)).toEqual([]);
  });
});
