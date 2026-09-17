import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { playbackRegistry } from '../services/playback-registry.js';
import { playbackRoutes } from './playback.js';

function appFor(userId: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: userId } as AuthEnv['Variables']['user']);
    await next();
  });
  app.route('/playback', playbackRoutes());
  return app;
}

const reset = (app: Hono<AuthEnv>) => app.request('/playback/session/reset', { method: 'POST' });
const read = (app: Hono<AuthEnv>) => app.request('/playback/session');

describe('GET /playback/session', () => {
  it("answers the caller's session state", async () => {
    const manager = playbackRegistry.getOrCreate('u-read');
    manager.registerDevice({ id: 'd1', name: 'Tab', type: 'web' });
    manager.updateState({ activeDeviceId: 'd1', isPlaying: true, trackId: 't1' });

    const res = await read(appFor('u-read'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      activeDeviceId: 'd1',
      isPlaying: true,
      trackId: 't1',
    });
  });

  it('is scoped to the caller: an untouched user reads an empty session', async () => {
    const res = await read(appFor('u-nobody'));
    expect(await res.json()).toMatchObject({
      activeDeviceId: null,
      isPlaying: false,
      trackId: null,
    });
  });
});

describe('POST /playback/session/reset', () => {
  it("ends the caller's session and answers 204", async () => {
    const manager = playbackRegistry.getOrCreate('u-reset');
    manager.registerDevice({ id: 'd1', name: 'Tab', type: 'web' });
    manager.updateState({ activeDeviceId: 'd1', isPlaying: true, trackId: 't1' });

    const res = await reset(appFor('u-reset'));

    expect(res.status).toBe(204);
    expect(manager.getState().activeDeviceId).toBeNull();
    expect(manager.getState().isPlaying).toBe(false);
    expect(manager.getState().trackId).toBeNull();
  });

  it("is scoped to the caller: another user's session is untouched", async () => {
    const other = playbackRegistry.getOrCreate('u-other');
    other.registerDevice({ id: 'o1', name: 'Tab', type: 'web' });
    other.updateState({ activeDeviceId: 'o1', isPlaying: true });

    await reset(appFor('u-reset'));

    expect(other.getState().activeDeviceId).toBe('o1');
    expect(other.getState().isPlaying).toBe(true);
  });
});
