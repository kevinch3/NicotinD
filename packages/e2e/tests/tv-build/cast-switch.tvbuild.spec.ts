/**
 * Casting to a shared TV as whoever you are (#1406): the TV keeps a listener
 * socket per stored person who is not active, so a phone signed in as that
 * person sees the TV in its picker; casting to it switches the TV to them and
 * plays the cast track. The "phone" is a bare socket speaking the protocol.
 */
import { ADMIN, bearer } from '../../helpers';
import { test, expect, tokenFor, approveOnScreen } from './tv-test';

const GUEST = { username: `e2e-caster-${Date.now()}`, password: 'e2e-caster-pass-123' };

interface Frame {
  type: string;
  payload?: {
    state?: { activeDeviceId?: string | null };
    devices?: Array<{ id: string; name: string; available?: boolean }>;
  };
}

test.describe('TV profile cast', () => {
  test.beforeAll(async ({ request }) => {
    const admin = await tokenFor(request, ADMIN);
    const created = await request.post('/api/admin/users', {
      headers: bearer(admin),
      data: { username: GUEST.username, password: GUEST.password },
    });
    expect(created.ok(), 'admin creates the guest').toBeTruthy();
  });

  test('a phone casting as a stored person switches the TV to them', async ({ page, request }) => {
    const consoleLines: string[] = [];
    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));

    // Store the guest, then make the admin active again: the guest now has a listener.
    await page.goto('/who');
    await page.getByTestId('tv-who-add').click();
    await expect(page).toHaveURL(/\/login/);
    await approveOnScreen(page, request, GUEST);
    await expect(page.getByTestId('tv-status-user')).toHaveText(GUEST.username);
    await page.goto('/who');
    // The row press is also the TV's user gesture — the server targets no device without one.
    await page.locator(`[data-testid="tv-who-row"][data-username="${ADMIN.username}"]`).click();
    await expect(page.getByTestId('tv-status-user')).toHaveText(ADMIN.username);

    const guestToken = await tokenFor(request, GUEST);
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(guestToken) })
    ).json()) as Array<{ id: string }>;
    expect(albums.length, 'the guest sees the fixture library').toBeGreaterThan(0);
    const detail = (await (
      await request.get(`/api/library/albums/${albums[0]!.id}`, { headers: bearer(guestToken) })
    ).json()) as { song: Array<{ id: string; title: string; artist: string; duration: number }> };
    const song = detail.song[0]!;
    const track = { id: song.id, title: song.title, artist: song.artist, duration: song.duration };

    const baseURL = test.info().project.use.baseURL!;
    const frames: Frame[] = [];
    const phone = new WebSocket(
      `${baseURL.replace(/^http/, 'ws')}/api/ws/playback?token=${encodeURIComponent(guestToken)}`,
    );
    phone.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Frame);
    const evidence = () =>
      `\n--- TV console ---\n${consoleLines.join('\n')}\n--- phone frames ---\n${frames
        .map((f) => JSON.stringify(f))
        .join('\n')}`;
    try {
      await new Promise<void>((resolve, reject) => {
        phone.onopen = () => resolve();
        phone.onerror = () => reject(new Error('the phone socket failed to open'));
      });
      phone.send(
        JSON.stringify({
          type: 'REGISTER',
          payload: {
            id: 'e2e-phone:tab',
            name: 'E2E Phone',
            deviceType: 'web',
            remoteEnabled: false,
            activated: true,
          },
        }),
      );

      const tvId = () => {
        for (let i = frames.length - 1; i >= 0; i--) {
          const devices = frames[i]!.payload?.devices;
          if (!devices) continue;
          const tv = devices.find((d) => d.name === 'NicotinD TV');
          return tv && tv.available !== false ? tv.id : undefined;
        }
        return undefined;
      };
      await expect
        .poll(tvId, {
          timeout: 15_000,
          message: `the TV is listed, available, in the guest's picker`,
        })
        .toBeTruthy();
      const id = tvId()!;

      phone.send(JSON.stringify({ type: 'SET_ACTIVE_DEVICE', payload: { id, queue: [] } }));
      phone.send(JSON.stringify({ type: 'COMMAND', payload: { action: 'SET_TRACK', track } }));

      await expect(page.getByTestId('tv-status-user'), `the TV switches`).toHaveText(
        GUEST.username,
        { timeout: 15_000 },
      );
      await expect(page, `the TV lands on the player`).toHaveURL(/\/player$/);
      await expect(page.getByTestId('tv-player-title'), `the TV plays the cast track`).toHaveText(
        track.title,
      );
    } catch (err) {
      // A cast that does not land is most likely a hand-over defect: carry
      // what the TV logged and what the phone saw into the failure.
      (err as Error).message += evidence();
      throw err;
    } finally {
      phone.close();
    }
  });
});
