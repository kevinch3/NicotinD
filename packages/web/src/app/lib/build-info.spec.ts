import { resolveBuildInfo, REPO_URL } from './build-info';

describe('resolveBuildInfo', () => {
  it('points the source offer at the exact tree a stamped build came from', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(resolveBuildInfo(sha)).toEqual({
      commit: sha,
      shortCommit: '0123456',
      sourceUrl: `${REPO_URL}/tree/${sha}`,
    });
  });

  it('accepts a short sha', () => {
    expect(resolveBuildInfo('abc1234').sourceUrl).toBe(`${REPO_URL}/tree/abc1234`);
  });

  // An unpassed `--define` arrives as '' — the common case for a local build.
  it.each([undefined, null, '', '   ', 'unset', '${GITHUB_SHA}', 'zzzzzzz'])(
    'falls back to the repository root for %p',
    (value) => {
      expect(resolveBuildInfo(value)).toEqual({
        commit: null,
        shortCommit: null,
        sourceUrl: REPO_URL,
      });
    },
  );

  it('never leaves the source offer without a URL', () => {
    // §13 is satisfied by a link that resolves, so this must hold for any input.
    for (const value of ['deadbeef', '', 'nope']) {
      expect(resolveBuildInfo(value).sourceUrl.startsWith(REPO_URL)).toBe(true);
    }
  });
});
