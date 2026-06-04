import { describe, expect, it } from 'bun:test';
import { SlskdSearchProvider } from './slskd-provider.js';

type BrowseRawDir = {
  name: string;
  fileCount: number;
  files: { filename: string; size: number }[];
};

function makeProvider(
  browseImpl: () => Promise<BrowseRawDir[]>,
  enqueueImpl: () => Promise<void> = async () => {},
  retryDelaysMs: number[] = [1, 1, 1],
) {
  const slskdRef = {
    current: {
      users: { browseUser: browseImpl },
      transfers: { enqueue: enqueueImpl },
    },
  } as unknown as ConstructorParameters<typeof SlskdSearchProvider>[0];
  return new SlskdSearchProvider(slskdRef, { retryDelaysMs });
}

describe('SlskdSearchProvider.browseUser retry', () => {
  it('returns dirs immediately when the first call succeeds', async () => {
    let calls = 0;
    const dirs: BrowseRawDir[] = [
      {
        name: 'Music\\Artist',
        fileCount: 1,
        files: [{ filename: 'Music\\Artist\\01.mp3', size: 1000 }],
      },
    ];
    const provider = makeProvider(async () => {
      calls++;
      return dirs;
    });

    const result = await provider.browseUser('alice');
    expect(calls).toBe(1);
    expect(result).toHaveLength(1);
    expect(result[0].files[0].filename).toBe('Music\\Artist\\01.mp3');
  });

  it('retries on 5xx errors and eventually succeeds', async () => {
    let calls = 0;
    const dirs: BrowseRawDir[] = [
      { name: 'Music\\Artist', fileCount: 1, files: [{ filename: 'a.mp3', size: 100 }] },
    ];
    const provider = makeProvider(async () => {
      calls++;
      if (calls < 3) throw new Error('slskd request failed: 500 /users/alice/browse');
      return dirs;
    });

    const result = await provider.browseUser('alice');
    expect(calls).toBe(3);
    expect(result).toHaveLength(1);
  });

  it('throws after exhausting retries when all attempts return 5xx', async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      calls++;
      throw new Error('slskd request failed: 503 /users/alice/browse');
    });

    await expect(provider.browseUser('alice')).rejects.toThrow('503');
    // Initial attempt + 3 retries = 4 calls
    expect(calls).toBe(4);
  });

  it('does not retry on 4xx errors (e.g. 404 user not found)', async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      calls++;
      throw new Error('slskd request failed: 404 /users/alice/browse');
    });

    await expect(provider.browseUser('alice')).rejects.toThrow('404');
    expect(calls).toBe(1);
  });

  it('filters files to supported audio formats only', async () => {
    const dirs: BrowseRawDir[] = [
      {
        name: 'Music\\Mixed',
        fileCount: 5,
        files: [
          { filename: 'a.mp3', size: 100 },
          { filename: 'b.flac', size: 200 },
          { filename: 'c.ogg', size: 300 },
          { filename: 'd.wav', size: 400 },
          { filename: 'e.exe', size: 500 },
        ],
      },
    ];
    const provider = makeProvider(async () => dirs);

    const result = await provider.browseUser('alice');
    expect(result[0].files.map((f) => f.filename)).toEqual(['a.mp3', 'b.flac', 'c.ogg', 'd.wav']);
    expect(result[0].fileCount).toBe(4);
  });

  it('throws BrowseUnavailableError when slskd is not configured', async () => {
    const slskdRef = { current: null } as unknown as ConstructorParameters<
      typeof SlskdSearchProvider
    >[0];
    const provider = new SlskdSearchProvider(slskdRef);
    await expect(provider.browseUser('alice')).rejects.toThrow('browse provider not available');
  });
});

describe('SlskdSearchProvider.download retry', () => {
  const files = [{ filename: 'a.mp3', size: 1000 }];

  it('enqueues immediately when the first call succeeds', async () => {
    let calls = 0;
    const provider = makeProvider(
      async () => [],
      async () => {
        calls++;
      },
    );
    await provider.download('alice', files);
    expect(calls).toBe(1);
  });

  it('retries on 5xx and succeeds on subsequent attempt', async () => {
    let calls = 0;
    const provider = makeProvider(
      async () => [],
      async () => {
        calls++;
        if (calls < 2) throw new Error('slskd request failed: 500 /transfers/downloads/alice');
      },
    );
    await provider.download('alice', files);
    expect(calls).toBe(2);
  });

  it('throws after exhausting retries when all enqueue attempts return 5xx', async () => {
    let calls = 0;
    const provider = makeProvider(
      async () => [],
      async () => {
        calls++;
        throw new Error('slskd request failed: 500 /transfers/downloads/alice');
      },
    );
    await expect(provider.download('alice', files)).rejects.toThrow('500');
    expect(calls).toBe(4);
  });

  it('does not retry on 4xx errors', async () => {
    let calls = 0;
    const provider = makeProvider(
      async () => [],
      async () => {
        calls++;
        throw new Error('slskd request failed: 400 /transfers/downloads/alice');
      },
    );
    await expect(provider.download('alice', files)).rejects.toThrow('400');
    expect(calls).toBe(1);
  });

  it('throws when slskd is not configured', async () => {
    const slskdRef = { current: null } as unknown as ConstructorParameters<
      typeof SlskdSearchProvider
    >[0];
    const provider = new SlskdSearchProvider(slskdRef);
    await expect(provider.download('alice', files)).rejects.toThrow('Soulseek is not configured');
  });
});
