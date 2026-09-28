#!/usr/bin/env bun
/**
 * Prune untagged GHCR package versions without breaking a multi-arch tag (#1461).
 *
 *   bun run scripts/ghcr-retention.ts --owner kevinch3 --package nicotind [--min-age-days 14] [--delete]
 *
 * Every green master commit pushes per-arch images by digest (ci.yml `edge-image`)
 * and re-points `:edge`, so untagged versions accumulate and nothing removed them.
 *
 * A generic "delete untagged versions" is wrong here. A multi-arch tag is an
 * image INDEX whose per-platform manifests (and buildx attestation manifests)
 * are separate package versions, and GHCR lists every one of them as untagged —
 * deleting them leaves `:edge`, `release` and every `vX.Y.Z` pointing at
 * nothing. So the keep set is the closure of every tagged version's index,
 * read from the registry, and only an untagged version outside it (and older
 * than the age floor) is deletable.
 *
 * Fails closed: a tagged manifest that cannot be read aborts the run before
 * anything is deleted. Without `--delete` it only reports.
 * docs/releasing.md "GHCR retention".
 */

/** One entry of `GET /users/{owner}/packages/container/{pkg}/versions`. */
export interface PackageVersion {
  id: number;
  /** The manifest digest, `sha256:…`. */
  name: string;
  created_at: string;
  updated_at: string;
  metadata?: { package_type?: string; container?: { tags?: string[] } };
}

/** A descriptor inside an image index (`manifests[]`). */
export interface Descriptor {
  digest: string;
  mediaType?: string;
}

const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

export const isIndex = (mediaType: string | undefined): boolean =>
  mediaType !== undefined && INDEX_TYPES.has(mediaType);

export const tagsOf = (v: PackageVersion): string[] => v.metadata?.container?.tags ?? [];

export interface Selection {
  delete: PackageVersion[];
  keep: { version: PackageVersion; reason: string }[];
}

/**
 * Every digest a tag reaches: each tagged version, plus — recursively — the
 * children of any index among them. `children` maps an INDEX digest to its
 * `manifests[]`; a plain image manifest has no entry and no children.
 *
 * Throws when a tagged digest, or a nested index, is missing from `children`
 * while being an index: the caller must fetch every one before selecting, and
 * a gap would otherwise read as "references nothing" and free its children.
 */
export function referencedDigests(
  versions: PackageVersion[],
  children: Map<string, Descriptor[] | null>,
): Map<string, string> {
  const reachedBy = new Map<string, string>();
  const visit = (digest: string, tag: string) => {
    if (reachedBy.has(digest)) return;
    reachedBy.set(digest, tag);
    if (!children.has(digest)) {
      throw new Error(`manifest ${digest} (reached from :${tag}) was not resolved`);
    }
    for (const d of children.get(digest) ?? []) visit(d.digest, tag);
  };
  for (const v of versions) {
    const tags = tagsOf(v);
    if (tags.length > 0) visit(v.name, tags[0]!);
  }
  return reachedBy;
}

/**
 * Which versions may be deleted: untagged, not reachable from any tag, and
 * whose newest timestamp is older than `minAgeDays` (an in-flight edge build's
 * per-arch digests are untagged for the minutes before `:edge` is stitched).
 */
export function selectDeletable(
  versions: PackageVersion[],
  children: Map<string, Descriptor[] | null>,
  opts: { now: Date; minAgeDays: number },
): Selection {
  const reached = referencedDigests(versions, children);
  const cutoff = opts.now.getTime() - opts.minAgeDays * 86_400_000;
  const out: Selection = { delete: [], keep: [] };
  for (const version of versions) {
    const tags = tagsOf(version);
    const newest = Math.max(Date.parse(version.created_at), Date.parse(version.updated_at));
    if (tags.length > 0) out.keep.push({ version, reason: `tagged ${tags.join(', ')}` });
    else if (reached.has(version.name))
      out.keep.push({ version, reason: `referenced by :${reached.get(version.name)}` });
    else if (!(newest < cutoff))
      out.keep.push({ version, reason: `younger than ${opts.minAgeDays} days` });
    else out.delete.push(version);
  }
  return out;
}

/**
 * The digests whose children must be known before selecting: every tagged
 * version, then every nested index found under them. `fetchChildren` returns
 * an index's `manifests[]`, or null for a plain image manifest.
 */
export async function resolveChildren(
  versions: PackageVersion[],
  fetchChildren: (digest: string) => Promise<Descriptor[] | null>,
): Promise<Map<string, Descriptor[] | null>> {
  const children = new Map<string, Descriptor[] | null>();
  let frontier = versions.filter((v) => tagsOf(v).length > 0).map((v) => v.name);
  while (frontier.length > 0) {
    const next: string[] = [];
    const batch = [...new Set(frontier)].filter((d) => !children.has(d));
    for (let i = 0; i < batch.length; i += 8) {
      const slice = batch.slice(i, i + 8);
      const fetched = await Promise.all(slice.map(fetchChildren));
      slice.forEach((digest, j) => {
        const kids = fetched[j] ?? null;
        children.set(digest, kids);
        for (const k of kids ?? []) {
          // A child that is (or might be) an index needs its own children; a
          // plain manifest is a leaf, recorded without a registry round trip.
          if (!k.mediaType || isIndex(k.mediaType)) next.push(k.digest);
          else if (!children.has(k.digest)) children.set(k.digest, null);
        }
      });
    }
    frontier = next;
  }
  return children;
}

// ---------------------------------------------------------------- I/O below

const TIMEOUT_MS = 30_000;
const ACCEPT = [
  ...INDEX_TYPES,
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

async function http(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status} ${await res.text()}`);
  }
  return res;
}

async function packagesBase(owner: string, token: string): Promise<string> {
  const res = await http(`https://api.github.com/users/${owner}`, { headers: apiHeaders(token) });
  const kind = ((await res.json()) as { type?: string }).type === 'Organization' ? 'orgs' : 'users';
  return `https://api.github.com/${kind}/${owner}/packages/container`;
}

const apiHeaders = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
});

async function listVersions(base: string, pkg: string, token: string): Promise<PackageVersion[]> {
  const all: PackageVersion[] = [];
  for (let page = 1; ; page++) {
    const res = await http(`${base}/${pkg}/versions?per_page=100&page=${page}`, {
      headers: apiHeaders(token),
    });
    const batch = (await res.json()) as PackageVersion[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

export function registryFetcher(owner: string, pkg: string, token: string | undefined) {
  let bearer: Promise<string> | undefined;
  const auth = () =>
    (bearer ??= http(
      `https://ghcr.io/token?scope=repository:${owner}/${pkg}:pull&service=ghcr.io`,
      token ? { headers: { Authorization: `Basic ${btoa(`${owner}:${token}`)}` } } : {},
    )
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token));
  return async (digest: string): Promise<Descriptor[] | null> => {
    const res = await http(`https://ghcr.io/v2/${owner}/${pkg}/manifests/${digest}`, {
      headers: { Accept: ACCEPT, Authorization: `Bearer ${await auth()}` },
    });
    const body = (await res.json()) as { mediaType?: string; manifests?: Descriptor[] };
    const type = body.mediaType ?? res.headers.get('content-type') ?? undefined;
    return isIndex(type) ? (body.manifests ?? []) : null;
  };
}

function parseArgs(argv: string[]) {
  const opts = { owner: '', packages: [] as string[], minAgeDays: 14, del: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owner') opts.owner = argv[++i] ?? '';
    else if (a === '--package') opts.packages.push(argv[++i] ?? '');
    else if (a === '--min-age-days') opts.minAgeDays = Number(argv[++i]);
    else if (a === '--delete') opts.del = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.owner || opts.packages.length === 0) throw new Error('--owner and --package required');
  // A floor below a day could race an edge build between its push and its tag.
  if (!Number.isFinite(opts.minAgeDays) || opts.minAgeDays < 1) {
    throw new Error('--min-age-days must be at least 1');
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required to list package versions');
  const base = await packagesBase(opts.owner, token);
  const mode = opts.del ? 'DELETE' : 'dry run';
  const summary = [
    `## GHCR retention (${mode})`,
    '',
    `Untagged versions older than ${opts.minAgeDays} days that no tag references.`,
    '',
    '| package | versions | tagged | kept (referenced) | kept (too young) | deletable |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const lines: string[] = [];
  for (const pkg of opts.packages) {
    const versions = await listVersions(base, pkg, token);
    const children = await resolveChildren(versions, registryFetcher(opts.owner, pkg, token));
    const sel = selectDeletable(versions, children, {
      now: new Date(),
      minAgeDays: opts.minAgeDays,
    });
    const count = (p: string) => sel.keep.filter((k) => k.reason.startsWith(p)).length;
    summary.push(
      `| ${pkg} | ${versions.length} | ${count('tagged')} | ${count('referenced')} | ${count('younger')} | ${sel.delete.length} |`,
    );
    for (const v of sel.delete) {
      lines.push(
        `${opts.del ? 'deleting' : 'would delete'} ${pkg} ${v.id} ${v.name} (${v.updated_at})`,
      );
      if (opts.del) {
        await http(`${base}/${pkg}/versions/${v.id}`, {
          method: 'DELETE',
          headers: apiHeaders(token),
        });
      }
    }
  }
  if (!opts.del) summary.push('', 'Dry run: nothing was deleted.');
  console.log(lines.join('\n'));
  console.log(summary.join('\n'));
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (out)
    await Bun.write(
      out,
      `${await Bun.file(out)
        .text()
        .catch(() => '')}${summary.join('\n')}\n`,
    );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
