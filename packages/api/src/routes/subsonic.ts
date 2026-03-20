import { Hono } from 'hono';
import type { NicotinDConfig } from '@nicotind/core';

/**
 * Transparent Subsonic API proxy at /rest/*
 * Forwards all requests to Navidrome so existing Subsonic clients
 * (DSub, Symfonium, play:Sub, etc.) work out of the box.
 */
export function subsonicProxy(config: NicotinDConfig) {
  const app = new Hono();

  app.all('/*', async (c) => {
    const path = c.req.path; // e.g., /rest/ping.view
    const queryString = new URL(c.req.url).search;
    const targetUrl = `${config.navidrome.url}${path}${queryString}`;

    const headers = new Headers(c.req.raw.headers);
    headers.delete('host');

    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  });

  return app;
}
