/**
 * Fail a release job that built desktop artifacts and published none of them.
 *
 *   bun run packages/desktop/scripts/verify-published-assets.ts --tag v0.8.39
 *
 * WHY: electron-builder's GitHub publisher refuses to upload into a release
 * whose type does not match its own `releaseType`. It logs one
 * `skipped publishing` line per file — and exits 0. deploy.yml's `release-notes`
 * job is ungated and has no `needs`, so it creates the tag's release as
 * *published* seconds after the tag lands, while the publisher was still on its
 * `draft` default. From v0.1.232 to v0.8.39 both desktop jobs built the
 * AppImage, the deb and the dmg, uploaded none of them, and reported success:
 * ~40 releases, two months, green every time, and `latest-*.yml` missing with
 * them so every installed app lost its update feed too (#1261).
 *
 * electron-builder.yml now pins `releaseType: release`, which fixes that
 * instance. This exists because the *class* outlives the fix: any future
 * publisher-side skip — a token that cannot write, a renamed target, a draft
 * created by a job that won the race — looks identical from outside. A step
 * that produces files and publishes none must be red.
 *
 * DENOMINATOR: the expectation is read off what electron-builder actually wrote
 * to `release/`, never a hardcoded asset list, which would quietly stop
 * covering a target someone adds. An empty artifact set is itself a failure —
 * that is a build that produced nothing, and a gate that passes on it is the
 * vacuous-pass shape this file exists to reject.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Where electron-builder writes its output (`directories.output`). */
export const RELEASE_DIR = resolve(import.meta.dir, '../release');

/**
 * Artifact extensions electron-builder publishes. Kept as a list of what goes
 * *up* rather than what lands in `release/`: that directory also holds the
 * unpacked app trees and `builder-debug.yml`/`builder-effective-config.yaml`,
 * which are build intermediates and are not release assets.
 */
const PUBLISHED_EXTENSIONS = ['.AppImage', '.deb', '.dmg', '.exe', '.zip', '.blockmap'];

/**
 * electron-updater's feed descriptors (`latest-linux.yml`, `latest-mac.yml`).
 * These matter as much as the installers: the updater polls them, so a release
 * missing one silently freezes every app already installed — which is the half
 * of #1261 nobody would have noticed from the releases page.
 */
const FEED_FILE = /^latest.*\.yml$/;

/** Is this filename something electron-builder was supposed to upload? */
export function isPublishedArtifact(name: string): boolean {
  return PUBLISHED_EXTENSIONS.some((ext) => name.endsWith(ext)) || FEED_FILE.test(name);
}

/** The artifacts a build produced, from the names in its output directory. */
export function publishedArtifacts(entries: string[]): string[] {
  return entries.filter(isPublishedArtifact).sort();
}

/** Produced artifacts that never made it onto the release, by name. */
export function missingFromRelease(produced: string[], assets: string[]): string[] {
  const present = new Set(assets);
  return produced.filter((name) => !present.has(name)).sort();
}

/** Names of the assets attached to the *published* release for a tag. */
export type AssetFetcher = (tag: string) => Promise<string[]>;

/**
 * Read a tag's release assets from the GitHub API.
 *
 * `/releases/tags/{tag}` deliberately resolves only *published* releases —
 * drafts are invisible to it. That is the assertion we want: v0.6.37 proved a
 * run can leave its artifacts on an orphan draft sharing the tag name, where
 * the releases page never shows them and the updater never finds them.
 */
export function githubAssetFetcher(repo: string, token: string): AssetFetcher {
  return async (tag) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      // Every outbound fetch carries an abort signal — see check:fetch-timeouts.
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} ${res.statusText} for release tag ${tag}`);
    }
    const body = (await res.json()) as { assets?: Array<{ name: string }> };
    return (body.assets ?? []).map((a) => a.name);
  };
}

/**
 * Poll until nothing is missing, or the attempts run out.
 *
 * Asset listings can lag a large upload by a few seconds, and a flaky red on a
 * release job costs more trust than it buys. The retry is bounded and only ever
 * *clears* a failure — it can never invent one — so the worst case is the same
 * verdict, later.
 */
export async function verifyPublished(
  produced: string[],
  fetchAssets: AssetFetcher,
  tag: string,
  { attempts = 6, delayMs = 5_000, sleep = defaultSleep } = {},
): Promise<string[]> {
  let missing = produced;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    missing = missingFromRelease(produced, await fetchAssets(tag));
    if (missing.length === 0) return [];
    if (attempt < attempts) await sleep(delayMs);
  }
  return missing;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const tag = flag('tag') ?? process.env.GITHUB_REF_NAME;
  const repo = flag('repo') ?? process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const label = flag('label') ?? 'desktop';

  if (!tag) throw new Error('No release tag: pass --tag or set GITHUB_REF_NAME.');
  if (!repo) throw new Error('No repository: pass --repo owner/name or set GITHUB_REPOSITORY.');
  if (!token) throw new Error('No token: set GH_TOKEN (or GITHUB_TOKEN).');

  const dir = flag('dir') ?? RELEASE_DIR;
  const produced = publishedArtifacts(
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name),
  );

  // A build that produced nothing must not pass for lack of anything to check.
  if (produced.length === 0) {
    throw new Error(
      `${label}: electron-builder wrote no publishable artifact to ${dir}. ` +
        `Expected at least one of ${PUBLISHED_EXTENSIONS.join(', ')} or a latest-*.yml feed.`,
    );
  }

  console.log(`${label}: built ${produced.length} artifact(s):\n  ${produced.join('\n  ')}`);

  const missing = await verifyPublished(produced, githubAssetFetcher(repo, token), tag);
  if (missing.length > 0) {
    throw new Error(
      `${label}: electron-builder built ${produced.length} artifact(s) but ${missing.length} ` +
        `never reached the ${tag} release:\n  ${missing.join('\n  ')}\n\n` +
        `Check the publish step's log for "skipped publishing" — the publisher exits 0 when it ` +
        `refuses to upload. See docs/desktop-app.md "Publishing to the GitHub Release" (#1261).`,
    );
  }

  console.log(`${label}: all ${produced.length} artifact(s) are on the ${tag} release. ✅`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
