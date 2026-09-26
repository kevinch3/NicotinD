/**
 * Casting to a shared TV as whoever you are (#1406): the TV keeps a listener
 * socket per stored person who is not active, so a phone signed in as that
 * person sees the TV in its picker; casting to it switches the TV to them and
 * plays the cast track. The "phone" is a bare socket speaking the protocol.
 *
 * The admin's own session is playing on the TV when the guest casts: the
 * switch must end it, or the admin's phone keeps showing "playing on TV" and
 * can never cast back (the outgoing person's listener re-registers the TV
 * inside the server's reconnect grace).
 */
import { ADMIN, FIXTURE, bearer } from '../../helpers';
import { test, expect, tokenFor, approveOnScreen } from './tv-test';

const GUEST = { username: `e2e-caster-${Date.now()}`, password: 'e2e-caster-pass-123' };

interface Frame {
  type: string;
  payload?: {
    state?: { activeDeviceId?: string | null; isPlaying?: boolean };
    devices?: Array<{ id: string; name: string; available?: boolean }>;
  };
}

/** A bare "phone" socket for `token`, registered as a non-output controller. */
async function phoneSocket(
  baseURL: string,
  token: string,
  id: string,
): Promise<{ socket: WebSocket; frames: Frame[] }> {
  const frames: Frame[] = [];
  const socket = new WebSocket(
    `${baseURL.replace(/^http/, 'ws')}/api/ws/playback?token=${encodeURIComponent(token)}`,
  );
  socket.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Frame);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`the ${id} socket failed to open`));
      timer = setTimeout(() => reject(new Error(`the ${id} socket did not open in 10 s`)), 10_000);
    });
  } catch (err) {
    socket.close();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  socket.send(
    JSON.stringify({
      type: 'REGISTER',
      payload: { id, name: id, deviceType: 'web', remoteEnabled: false, activated: true },
    }),
  );
  return { socket, frames };
}

/** The session's output as this socket last heard it (echo or broadcast). */
function lastActive(frames: Frame[]): string | null | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const state = frames[i]!.payload?.state;
    if (frames[i]!.type === 'STATE_SYNC' && state && 'activeDeviceId' in state) {
      return state.activeDeviceId ?? null;
    }
  }
  return undefined;
}

/** The TV's device id from the last device list this socket heard. */
function tvIdIn(frames: Frame[], requireAvailable: boolean): string | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const devices = frames[i]!.payload?.devices;
    if (!devices) continue;
    const tv = devices.find((d) => d.name === 'NicotinD TV');
    if (!tv || (requireAvailable && tv.available === false)) return undefined;
    return tv.id;
  }
  return undefined;
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

    // The admin plays on the TV: their session's output is now the TV.
    await page.goto('/library');
    await page.getByTestId('tv-album-card').filter({ hasText: FIXTURE.album.title }).click();
    await page.getByTestId('tv-album-play').click();
    await expect(page).toHaveURL(/\/player$/);
    await expect(page.getByTestId('tv-player-title')).toBeVisible();

    const baseURL = test.info().project.use.baseURL!;
    const adminPhone = await phoneSocket(
      baseURL,
      await tokenFor(request, ADMIN),
      'e2e-admin-phone:tab',
    );
    const adminEvidence = () =>
      `\n--- admin phone frames ---\n${adminPhone.frames.map((f) => JSON.stringify(f)).join('\n')}`;
    let tvId: string | undefined;
    try {
      await expect
        .poll(() => tvIdIn(adminPhone.frames, false), {
          timeout: 10_000,
          message: 'the TV is registered under the admin',
        })
        .toBeTruthy();
      tvId = tvIdIn(adminPhone.frames, false)!;
      await expect
        .poll(() => lastActive(adminPhone.frames), {
          timeout: 10_000,
          message: "the admin's session plays on the TV before the cast",
        })
        .toBe(tvId);
    } catch (err) {
      adminPhone.socket.close();
      (err as Error).message += adminEvidence();
      throw err;
    }

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

    let phone: WebSocket | undefined;
    let frames: Frame[] = [];
    const evidence = () =>
      `\n--- TV console ---\n${consoleLines.join('\n')}\n--- phone frames ---\n${frames
        .map((f) => JSON.stringify(f))
        .join('\n')}${adminEvidence()}`;
    try {
      ({ socket: phone, frames } = await phoneSocket(baseURL, guestToken, 'e2e-phone:tab'));

      await expect
        .poll(() => tvIdIn(frames, true), {
          timeout: 15_000,
          message: `the TV is listed, available, in the guest's picker`,
        })
        .toBeTruthy();
      const id = tvIdIn(frames, true)!;

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

      // The switch ended the admin's session: it no longer names the TV.
      await expect
        .poll(() => lastActive(adminPhone.frames), {
          timeout: 10_000,
          message: "the admin's session is released from the TV",
        })
        .not.toBe(tvId);
      // And a phone of the admin's connecting now is told so in its echo.
      const late = await phoneSocket(baseURL, await tokenFor(request, ADMIN), 'e2e-admin-late:tab');
      try {
        await expect
          .poll(() => lastActive(late.frames), {
            timeout: 10_000,
            message: "a new admin phone's registration echo does not name the TV",
          })
          .not.toBeUndefined();
        expect(lastActive(late.frames)).not.toBe(tvId);
      } finally {
        late.socket.close();
      }
    } catch (err) {
      // A cast that does not land is most likely a hand-over defect: carry
      // what the TV logged and what the phone saw into the failure.
      (err as Error).message += evidence();
      throw err;
    } finally {
      phone?.close();
      adminPhone.socket.close();
    }
  });
});
