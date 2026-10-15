import { test, expect } from '../helpers';
import { FIXTURE, expandGroup } from '../helpers';

type SubsonicBody<T> = { 'subsonic-response': T & { status: string } };

/**
 * OpenSubsonic (docs/opensubsonic.md): a key minted on Settings → Subsonic apps
 * signs a Subsonic client in to `/rest`. The `request` fixture is deliberately
 * unauthenticated here — the API key is the whole credential, exactly as Music
 * Assistant presents it — and the calls run against the real server and the
 * real fixture library.
 */
test.describe('opensubsonic', () => {
  test('a key from settings browses, enumerates and streams the library, then revokes', async ({
    page,
    request,
  }) => {
    await page.goto('/settings/subsonic');
    await expandGroup(page, 'subsonic-connect');
    await expect(page.getByTestId('subsonic-server-url')).not.toBeEmpty();

    await expandGroup(page, 'subsonic-keys-new');
    await page.getByTestId('subsonic-key-name-input').fill('e2e music assistant');
    await page.getByTestId('subsonic-key-mint').click();
    const key = (await page.getByTestId('subsonic-key-secret').textContent())?.trim() ?? '';
    expect(key).toMatch(/^nss_/);

    const rest = async <T = Record<string, unknown>>(
      method: string,
      params: Record<string, string> = {},
    ) => {
      const q = new URLSearchParams({ apiKey: key, f: 'json', v: '1.16.1', c: 'e2e', ...params });
      const res = await request.get(`/rest/${method}?${q}`);
      const body = (await res.json()) as SubsonicBody<T>;
      return body['subsonic-response'];
    };

    expect((await rest('ping')).status).toBe('ok');

    // Music Assistant's sync: page the whole library through an empty search3.
    const all = await rest<{
      searchResult3: { song: Array<{ id: string; album: string }>; album: Array<{ name: string }> };
    }>('search3', { query: '', songCount: '500', albumCount: '500' });
    expect(all.searchResult3.album.map((a) => a.name)).toContain(FIXTURE.album.title);
    const tracks = all.searchResult3.song.filter((s) => s.album === FIXTURE.album.title);
    expect(tracks.length).toBe(FIXTURE.album.trackCount);

    const stream = await request.get(
      `/rest/stream?${new URLSearchParams({ apiKey: key, id: tracks[0]!.id, format: 'raw' })}`,
      { headers: { Range: 'bytes=0-3' } },
    );
    expect(stream.status()).toBe(206);
    expect((await stream.body()).length).toBe(4);

    // Revoking signs the app out at once.
    await page.reload();
    await expandGroup(page, 'subsonic-keys-list');
    const row = page.getByTestId('subsonic-key-row').filter({ hasText: 'e2e music assistant' });
    await row.getByTestId('subsonic-key-revoke').click();
    await expect(row).toHaveCount(0);
    const after = await rest<{ error: { code: number } }>('ping');
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe(44);
  });
});
