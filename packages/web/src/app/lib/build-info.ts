/**
 * Build identity of this bundle — the commit the AGPL §13 source offer points
 * at. → docs/licensing.md
 *
 * Threaded the same way the version is: resolved when the bundle is built,
 * never fetched at runtime. It cannot come from a tracked file the way the
 * version does, because a value derived from HEAD is stale the moment it is
 * committed — so the bundler substitutes it instead
 * (`ng build --define NICOTIND_BUILD_COMMIT="<sha>"`, wired from the image's
 * build arg). A build that passes none resolves to null and the offer falls
 * back to the repository root.
 */
declare const NICOTIND_BUILD_COMMIT: string | undefined;

export const REPO_URL = 'https://github.com/kevinch3/NicotinD';

/** Canonical AGPL-3.0 text, for readers who don't have the repo checked out. */
export const LICENCE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

export interface BuildInfo {
  /** Commit sha this bundle was built from, or null when unstamped. */
  commit: string | null;
  /** Display form of {@link commit}. */
  shortCommit: string | null;
  /** The exact source of THIS build; the repo root when the commit is unknown. */
  sourceUrl: string;
}

/**
 * An unpassed `--define` arrives as the empty string rather than as undefined,
 * and a mis-wired one as whatever the shell left behind — so the sha is
 * validated rather than trusted. An invalid stamp degrades to "unknown", which
 * still satisfies §13 through the repository link.
 */
export function resolveBuildInfo(commit?: string | null): BuildInfo {
  const sha = (commit ?? '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { commit: null, shortCommit: null, sourceUrl: REPO_URL };
  }
  return { commit: sha, shortCommit: sha.slice(0, 7), sourceUrl: `${REPO_URL}/tree/${sha}` };
}

// `typeof` guard, not a bare read: with no `--define` the identifier is a free
// variable and reading it would throw.
export const BUILD_INFO: BuildInfo = resolveBuildInfo(
  typeof NICOTIND_BUILD_COMMIT === 'string' ? NICOTIND_BUILD_COMMIT : null,
);
