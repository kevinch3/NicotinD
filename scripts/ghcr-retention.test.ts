import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  resolveChildren,
  selectDeletable,
  type Descriptor,
  type PackageVersion,
} from './ghcr-retention.js';

/**
 * Fixtures are shaped like the real responses: package versions as
 * `GET /users/{owner}/packages/container/{pkg}/versions` returns them, and the
 * index as ghcr.io serves `nicotind:edge` — a flattened OCI index of two
 * platform manifests plus one buildx attestation manifest per platform, each a
 * separate, untagged package version.
 */
const NOW = new Date('2026-09-28T12:00:00Z');
const OLD = '2026-08-01T00:00:00Z';
const d = (n: string) => `sha256:${n.repeat(64).slice(0, 64)}`;

let nextId = 1000;
const version = (digest: string, tags: string[] = [], at = OLD): PackageVersion =>
  ({
    id: nextId++,
    name: digest,
    url: `https://api.github.com/users/kevinch3/packages/container/nicotind/versions/${nextId}`,
    package_html_url: 'https://github.com/users/kevinch3/packages/container/package/nicotind',
    created_at: at,
    updated_at: at,
    html_url: `https://github.com/users/kevinch3/packages/container/nicotind/${nextId}`,
    metadata: { package_type: 'container', container: { tags } },
  }) as PackageVersion;

const IMAGE = 'application/vnd.oci.image.manifest.v1+json';
const INDEX = 'application/vnd.oci.image.index.v1+json';

/** What ghcr.io returns for a multi-arch tag stitched by `imagetools create`. */
const multiArch = (amd: string, amdAtt: string, arm: string, armAtt: string): Descriptor[] => [
  { mediaType: IMAGE, digest: amd },
  { mediaType: IMAGE, digest: amdAtt },
  { mediaType: IMAGE, digest: arm },
  { mediaType: IMAGE, digest: armAtt },
];

// `:edge` now; the previous edge index (tag moved off it); a release; and the
// per-arch indexes build-push-action pushed by digest before the stitch.
const edge = { index: d('e'), amd: d('1'), amdAtt: d('2'), arm: d('3'), armAtt: d('4') };
const prevEdge = { index: d('f'), amd: d('5'), amdAtt: d('6'), arm: d('7'), armAtt: d('8') };
const release = { index: d('a'), amd: d('9'), amdAtt: d('b'), arm: d('c'), armAtt: d('0') };
const pushedByDigest = d('d'); // a per-arch index, untagged once stitched

const registry = new Map<string, Descriptor[] | null>([
  [edge.index, multiArch(edge.amd, edge.amdAtt, edge.arm, edge.armAtt)],
  [prevEdge.index, multiArch(prevEdge.amd, prevEdge.amdAtt, prevEdge.arm, prevEdge.armAtt)],
  [release.index, multiArch(release.amd, release.amdAtt, release.arm, release.armAtt)],
  [pushedByDigest, [{ mediaType: IMAGE, digest: prevEdge.amd }]],
]);
const fetchChildren = async (digest: string) => {
  if (!registry.has(digest)) throw new Error(`404 ${digest}`);
  return registry.get(digest) ?? null;
};

const versions = [
  version(edge.index, ['edge'], '2026-09-28T11:00:00Z'),
  ...[edge.amd, edge.amdAtt, edge.arm, edge.armAtt].map((x) => version(x)),
  version(prevEdge.index),
  ...[prevEdge.amd, prevEdge.amdAtt, prevEdge.arm, prevEdge.armAtt].map((x) => version(x)),
  version(release.index, ['v0.8.104', 'v0', 'release']),
  ...[release.amd, release.amdAtt, release.arm, release.armAtt].map((x) => version(x)),
  version(pushedByDigest),
];

const deletable = async (vs: PackageVersion[], minAgeDays = 14) =>
  selectDeletable(vs, await resolveChildren(vs, fetchChildren), { now: NOW, minAgeDays })
    .delete.map((v) => v.name)
    .sort();

describe('GHCR retention selection (#1461)', () => {
  it('keeps every per-arch and attestation manifest a tag points to', async () => {
    const del = await deletable(versions);
    for (const kept of [edge, release].flatMap((t) => [t.amd, t.amdAtt, t.arm, t.armAtt])) {
      expect(del).not.toContain(kept);
    }
  });

  it('never deletes a tagged version', async () => {
    const del = await deletable(versions);
    expect(del).not.toContain(edge.index);
    expect(del).not.toContain(release.index);
  });

  it('deletes the untagged indexes and the manifests only they referenced', async () => {
    expect(await deletable(versions)).toEqual(
      [
        prevEdge.index,
        prevEdge.amd,
        prevEdge.amdAtt,
        prevEdge.arm,
        prevEdge.armAtt,
        pushedByDigest,
      ].sort(),
    );
  });

  it('keeps untagged versions younger than the floor', async () => {
    const fresh = versions.map((v) =>
      v.name === prevEdge.amd ? { ...v, updated_at: '2026-09-27T00:00:00Z' } : v,
    );
    expect(await deletable(fresh)).not.toContain(prevEdge.amd);
    // `updated_at` counts too, not only `created_at`.
    expect(await deletable(fresh, 0.5)).toContain(prevEdge.amd);
  });

  it('follows a nested index down to its manifests', async () => {
    const nested = d('9').replace('9', '7');
    const reg = new Map(registry);
    reg.set(nested, [{ mediaType: INDEX, digest: prevEdge.index }]);
    const vs = [...versions, version(nested, ['v0.8.50'])];
    const sel = selectDeletable(vs, await resolveChildren(vs, async (x) => reg.get(x) ?? null), {
      now: NOW,
      minAgeDays: 14,
    });
    const del = sel.delete.map((v) => v.name);
    for (const kept of [prevEdge.index, prevEdge.amd, prevEdge.armAtt])
      expect(del).not.toContain(kept);
  });

  it('fails closed when a tagged manifest cannot be read', async () => {
    const vs = [...versions, version(d('6').replace('6', '5'), ['v0.1.329'])];
    await expect(resolveChildren(vs, fetchChildren)).rejects.toThrow('404');
    // And the selection itself refuses a keep set with a hole in it.
    expect(() => selectDeletable(vs, new Map(), { now: NOW, minAgeDays: 14 })).toThrow(
      'was not resolved',
    );
  });

  it('only asks the registry about tagged versions and nested indexes', async () => {
    const asked: string[] = [];
    await resolveChildren(versions, async (x) => {
      asked.push(x);
      return fetchChildren(x);
    });
    expect(asked.sort()).toEqual([edge.index, release.index].sort());
  });
});

/**
 * Merging the workflow deletes nothing: a scheduled run only reports unless the
 * owner sets GHCR_RETENTION_DELETE, a manual one only when `delete` is ticked,
 * and neither deletes off master.
 */
describe('ghcr-retention.yml is a dry run unless told otherwise', () => {
  type WfStep = { run?: string; env?: Record<string, string> };
  const wf = parse(
    readFileSync(join(import.meta.dir, '..', '.github/workflows/ghcr-retention.yml'), 'utf8'),
  ) as {
    on: {
      schedule?: unknown;
      workflow_dispatch?: { inputs?: Record<string, { default?: unknown }> };
    };
    jobs: Record<string, { steps?: WfStep[] }>;
  };
  const step = (wf.jobs.prune?.steps ?? []).find((s) => s.run?.includes('ghcr-retention.ts'))!;

  it('runs on a schedule, with deleting off by default', () => {
    expect(wf.on.schedule).toBeDefined();
    expect(wf.on.workflow_dispatch?.inputs?.delete?.default).toBe(false);
  });

  it('passes --delete only when DELETE is true, and DELETE needs master plus an explicit opt-in', () => {
    expect(step.run).toContain('if [ "$DELETE" = "true" ]; then args+=(--delete); fi');
    const del = step.env?.DELETE ?? '';
    expect(del).toContain("github.ref == 'refs/heads/master' &&");
    expect(del).toContain("github.event_name == 'workflow_dispatch' && inputs.delete");
    expect(del).toContain(
      "github.event_name == 'schedule' && vars.GHCR_RETENTION_DELETE == 'true'",
    );
  });

  it('prunes both images the pipeline pushes', () => {
    expect(step.run).toContain('--package nicotind ');
    expect(step.run).toContain('--package nicotind-analysis');
  });
});
