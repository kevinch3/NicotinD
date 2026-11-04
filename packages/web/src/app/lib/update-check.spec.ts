import {
  MAX_UPDATE_ATTEMPTS,
  PENDING_UPDATE_TTL_MS,
  afterUpdateReload,
  parseHealth,
  resetServiceWorker,
  sameCommit,
  servedBuildVerdict,
} from './update-check';

const A = 'b591028d0885ed50e49ef38c9d3852a029f8431a';
const B = '37eae47aaba5e5233efdd2abd49b49305385cdc5';

describe('parseHealth', () => {
  it('reads version and commit', () => {
    expect(parseHealth({ ok: true, version: '0.8.119', commit: B })).toEqual({
      version: '0.8.119',
      commit: B,
    });
  });

  it('drops an "unknown" version and a commit that is not a sha', () => {
    expect(parseHealth({ ok: true, version: 'unknown', commit: 'not-a-sha' })).toEqual({
      version: null,
      commit: null,
    });
    expect(parseHealth({ ok: true, version: '0.8.119', commit: null })).toEqual({
      version: '0.8.119',
      commit: null,
    });
  });

  it('rejects a body that is not an object', () => {
    expect(parseHealth('ok')).toBeNull();
    expect(parseHealth(null)).toBeNull();
  });
});

describe('sameCommit', () => {
  it('matches a full sha against its abbreviation, either way round, any case', () => {
    expect(sameCommit(A, A.slice(0, 7))).toBe(true);
    expect(sameCommit(A.slice(0, 7).toUpperCase(), A)).toBe(true);
    expect(sameCommit(A, B)).toBe(false);
  });
});

describe('servedBuildVerdict', () => {
  it('a different commit is an update even when the version strings match (edge builds)', () => {
    expect(
      servedBuildVerdict({ version: '0.8.119', commit: B }, { version: '0.8.119', commit: A }),
    ).toBe('update');
  });

  it('the same commit is current even if the versions disagree', () => {
    expect(
      servedBuildVerdict({ version: '0.8.120', commit: A }, { version: '0.8.119', commit: A }),
    ).toBe('current');
  });

  it('falls back to the version when either side has no commit, and only newer counts', () => {
    expect(
      servedBuildVerdict({ version: '0.8.120', commit: null }, { version: '0.8.119', commit: A }),
    ).toBe('update');
    expect(
      servedBuildVerdict({ version: '0.8.119', commit: B }, { version: '0.8.119', commit: null }),
    ).toBe('current');
    expect(
      servedBuildVerdict(
        { version: '0.8.118', commit: null },
        { version: '0.8.119', commit: null },
      ),
    ).toBe('current');
    expect(
      servedBuildVerdict({ version: null, commit: null }, { version: '0.8.119', commit: null }),
    ).toBe('current');
  });
});

describe('afterUpdateReload', () => {
  const now = 1_000_000;

  it('landed when the running build is the target, or there was no target', () => {
    expect(afterUpdateReload({ commit: B, attempts: 1, at: now }, B.slice(0, 7), now)).toBe(
      'landed',
    );
    expect(afterUpdateReload({ commit: null, attempts: 1, at: now }, A, now)).toBe('landed');
    expect(afterUpdateReload({ commit: B, attempts: 1, at: now }, null, now)).toBe('landed');
  });

  it('escalates a stale reload while attempts remain, then gives up', () => {
    expect(afterUpdateReload({ commit: B, attempts: 1, at: now }, A, now)).toBe('escalate');
    expect(afterUpdateReload({ commit: B, attempts: MAX_UPDATE_ATTEMPTS, at: now }, A, now)).toBe(
      'give-up',
    );
  });

  it('gives up on a record from some earlier session', () => {
    expect(
      afterUpdateReload({ commit: B, attempts: 1, at: now - PENDING_UPDATE_TTL_MS - 1 }, A, now),
    ).toBe('give-up');
  });
});

describe('resetServiceWorker', () => {
  it('unregisters every worker and drops only the ngsw caches', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const del = vi.fn().mockResolvedValue(true);
    await resetServiceWorker(
      { getRegistrations: async () => [{ unregister } as unknown as ServiceWorkerRegistration] },
      { keys: async () => ['ngsw:/:db:control', 'ngsw:/:1:assets:app:cache', 'mine'], delete: del },
    );
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(del.mock.calls.map((c) => c[0])).toEqual([
      'ngsw:/:db:control',
      'ngsw:/:1:assets:app:cache',
    ]);
  });

  it('tolerates a browser with neither', async () => {
    await expect(resetServiceWorker(undefined, undefined)).resolves.toBeUndefined();
  });
});
