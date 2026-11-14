import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getCurrentUser, requireAcquirer } from '../middleware/current-user.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { TrackGetService } from '../services/track-get.service.js';

/**
 * `POST /api/downloads/track` — the one-click track Get (#1885), mounted inside
 * `downloadRoutes` so it shares its auth and acquirer gate.
 * Body: `{ artist, title, album? }`. Answers 202 with the reserved job's id; the
 * outcome is read off the downloads feed, like an album Get.
 */
export function trackGetRoutes(trackGet: TrackGetService) {
  const app = new Hono<AuthEnv>();
  // requireAcquirer's ForbiddenError maps to 403 even when mounted bare (tests).
  app.onError(errorHandler);

  app.post('/track', async (c) => {
    requireAcquirer(c);
    const body = await c.req
      .json<{ artist?: unknown; title?: unknown; album?: unknown }>()
      .catch(() => null);
    const artist = typeof body?.artist === 'string' ? body.artist.trim() : '';
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!artist || !title) return c.json({ error: 'artist and title are required' }, 400);
    const answer = trackGet.request({
      artist,
      title,
      album: typeof body?.album === 'string' ? body.album : null,
      userId: getCurrentUser(c).sub,
    });
    if (answer.status === 'no-addon') {
      return c.json({ error: 'No acquisition addon registered' }, 503);
    }
    return c.json({ jobId: answer.jobId }, 202);
  });

  return app;
}
