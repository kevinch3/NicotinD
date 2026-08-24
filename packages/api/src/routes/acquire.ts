import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAcquirer } from '../middleware/current-user.js';
import {
  AcquireWatcher,
  NoAcquisitionPluginError,
  PluginUnavailableError,
} from '../services/acquire-watcher.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { resolveAddonForUrl } from '../services/addons/resolve-router.js';
import { AddonRequestError } from '../services/addons/client.js';
import { mapAddonJob } from '../services/addons/job-poller.js';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import { createJob } from '../services/acquisition-job-store.js';
import {
  addonRefForUrlJob,
  addonUrlJobUrl,
  findInFlightAddonUrlJob,
  getAddonUrlJob,
  listAddonUrlJobs,
} from '../services/addon-url-jobs.js';
import { resolveAcquireAs, type AcquireJob } from '@nicotind/core';

interface SubmitBody {
  url: string;
  /**
   * Classifier override. `'playlist'` is honored for any URL the classifier
   * did NOT already recognize as a playlist (archive.org items — the web's
   * "Treat as playlist" toggle — and unrecognized custom links alike);
   * `'album'` downgrades a recognized playlist URL to a single-item acquire.
   * Spotify/YouTube playlist URLs auto-detect and need no override.
   */
  as?: 'playlist' | 'album';
}

/**
 * URL acquisition routes. Backend selection is not hardcoded: the POST first
 * routes the URL to a `resolve`-capable **addon** (`resolveAddonForUrl` — the
 * bundled archive addon plus the external yt-dlp/spotdl ones) and eagerly
 * mirrors a `kind:url` job; failing that it falls back to an in-process
 * `resolve` plugin via the watcher. When neither handles it the submit
 * returns 503.
 *
 * Both paths are **idempotent per URL**: re-submitting a link whose job is
 * still in flight returns that job instead of starting a second download. The
 * watcher has always enforced that for the in-process path; the addon path did
 * not, which is what let a YouTube/Spotify paste be downloaded N times.
 * `GET /jobs` likewise reports both paths, so the web's link card can actually
 * see the job it just started and stop offering **Get**.
 */
export function acquireRoutes(watcher: AcquireWatcher, registry: PluginRegistry, db: Database) {
  const app = new Hono<AuthEnv>();

  // Acquisition is hidden from listeners — gate the whole group server-side.
  app.use('*', async (c, next) => {
    requireAcquirer(c);
    await next();
  });

  /**
   * Start (or re-join) an addon-run URL job. The addon gets an
   * `Idempotency-Key` derived from the URL so its own dedupe engages too, and a
   * 409 (addon-side in-flight guard) resolves back to the core row rather than
   * surfacing as an error the user would retry.
   */
  async function startAddonUrlJob(
    addon: RemoteAddonPlugin,
    url: string,
    as: SubmitBody['as'],
    userId: string,
  ): Promise<{ jobId: string; reused: boolean }> {
    const addonId = addon.addonManifest.id;
    const existing = findInFlightAddonUrlJob(db, url);
    if (existing) return { jobId: existing.id, reused: true };

    // Tell the addon what the link IS. The classifier has always known, but its
    // verdict was only ever read inside `AcquireWatcher` — the in-process engine
    // that no longer runs — so since the addon split every Spotify/YouTube
    // playlist arrived as a bare `as: undefined`, indistinguishable from a
    // single track. The caller's override still wins where it always did.
    const resolvedAs = resolveAcquireAs(url, as ?? null);
    let addonJob;
    try {
      addonJob = await addon.client.createJob({ intent: 'url', url, as: resolvedAs }, `url:${url}`);
    } catch (err) {
      if (err instanceof AddonRequestError && err.status === 409) {
        // The addon is already working on this link. If we know the core row,
        // hand it back; otherwise the poller will mirror it on its next tick.
        const known = findInFlightAddonUrlJob(db, url);
        if (known) return { jobId: known.id, reused: true };
      }
      throw err;
    }

    const coreJobId = createJob(db, {
      kind: 'url',
      method: addonId,
      // Nothing is downloading yet — the addon resolves in the background — and
      // the column default says otherwise. A link the addon cannot handle would
      // otherwise render "Downloading 0 of 0" for as long as the row lived.
      stage: 'queued',
      sourceRef: `addon:${addonId}:${addonJob.id}`,
      sourceUrl: url,
      // Playlist-from-acquisition on the addon lane (issue #587): the row
      // needs its own copy of who submitted it and whether the link is a
      // playlist, since AddonJobPoller's materialize step has no plugin-side
      // emitTrack callback to learn either from (unlike the legacy engine).
      userId,
      isPlaylist: resolvedAs === 'playlist',
      files: [],
    });
    mapAddonJob(db, addonId, addonJob.id, coreJobId);
    return { jobId: coreJobId, reused: false };
  }

  app.post('/', async (c) => {
    let body: SubmitBody;
    try {
      body = await c.req.json<SubmitBody>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    let url: URL;
    try {
      url = new URL(body.url);
    } catch {
      return c.json({ error: 'url must be a valid URL' }, 400);
    }

    // Prefer a resolve-capable addon (bundled archive, external yt-dlp/spotdl).
    // The addon resolves in the background; we eagerly mirror an
    // `acquisition_jobs` row so the Downloads card appears in-flight right away
    // (fixing #509 cause 2), and map it so the poller reuses the row.
    const addon = resolveAddonForUrl(registry, url.href);
    if (addon) {
      try {
        const { jobId, reused } = await startAddonUrlJob(addon, url.href, body.as, c.var.user.sub);
        // 200 + `reused` says "this link is already downloading" without
        // pretending a second job was created.
        return c.json({ jobId, reused }, reused ? 200 : 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to start acquire job';
        return c.json({ error: message }, 500);
      }
    }

    try {
      // Fall back to an in-process resolve plugin. Thread the authenticated user
      // id through so a playlist URL can generate a per-user native playlist on
      // completion. `submit` is itself idempotent for an in-flight URL.
      const jobId = await watcher.submit(url.href, undefined, {
        userId: c.var.user.sub,
        as: body.as,
      });
      return c.json({ jobId }, 201);
    } catch (err) {
      if (err instanceof NoAcquisitionPluginError || err instanceof PluginUnavailableError) {
        return c.json({ error: err.message }, 503);
      }
      const message = err instanceof Error ? err.message : 'Failed to start acquire job';
      return c.json({ error: message }, 500);
    }
  });

  // Both engines' URL jobs in one list, newest first — the web tracks a pasted
  // link by matching this list on `url`, so an addon job missing here reads as
  // "nothing happened" and invites a second click.
  app.get('/jobs', (c) => {
    const jobs: AcquireJob[] = [...watcher.listJobs(), ...listAddonUrlJobs(db)].sort(
      (a, b) => b.created_at - a.created_at,
    );
    return c.json(jobs);
  });

  app.get('/jobs/:id', (c) => {
    const id = c.req.param('id');
    const job = watcher.getJob(id) ?? getAddonUrlJob(db, id);
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json(job);
  });

  app.delete('/jobs/:id', async (c) => {
    const id = c.req.param('id');
    if (watcher.cancel(id)) return c.json({ ok: true });
    if (watcher.deleteJob(id)) return c.json({ ok: true });
    // Addon-run URL job: cancel + delete addon-side (best-effort — the row is
    // core-owned and must go either way, mirroring DELETE /api/downloads/jobs/:id).
    const addonJob = getAddonUrlJob(db, id);
    if (addonJob) {
      const ref = addonRefForUrlJob(db, id);
      const addon = ref ? registry.get(ref.addonId) : null;
      if (ref && addon instanceof RemoteAddonPlugin) {
        await addon.client.cancelJob(ref.addonJobId).catch(() => {});
        await addon.client.deleteJob(ref.addonJobId).catch(() => {});
      }
      db.run(`DELETE FROM acquisition_job_items WHERE job_id = ?`, [id]);
      db.run(`DELETE FROM acquisition_jobs WHERE id = ?`, [id]);
      return c.json({ ok: true });
    }
    return c.json({ error: 'Job not found' }, 404);
  });

  app.post('/jobs/:id/retry', async (c) => {
    const id = c.req.param('id');
    // Addon-run URL job: there is no in-process job to resume, so retry means
    // "submit the same link again" — safe because the in-flight guard above
    // makes it a no-op while the original is still running.
    const addonJob = getAddonUrlJob(db, id);
    if (addonJob) {
      const url = addonUrlJobUrl(db, id);
      const addon = url ? resolveAddonForUrl(registry, url) : null;
      if (!url || !addon) {
        return c.json({ error: 'No addon can handle this link any more' }, 503);
      }
      try {
        const { jobId, reused } = await startAddonUrlJob(addon, url, undefined, c.var.user.sub);
        return c.json({ jobId, reused }, reused ? 200 : 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Retry failed';
        return c.json({ error: message }, 502);
      }
    }
    try {
      const newJobId = await watcher.retryJob(id, { userId: c.var.user.sub });
      if (!newJobId) return c.json({ error: 'Job not found' }, 404);
      return c.json({ jobId: newJobId }, 201);
    } catch (err) {
      if (err instanceof NoAcquisitionPluginError || err instanceof PluginUnavailableError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
  });

  return app;
}
