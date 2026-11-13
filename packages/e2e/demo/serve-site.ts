/**
 * Serves a built Pages site the way GitHub Pages does, for the demo smoke spec:
 * `/NicotinD/<path>` maps onto `<site>/<path>`, a directory serves its
 * `index.html`, and a miss serves `<site>/404.html` with status 404.
 *
 *   bun run demo/serve-site.ts <site-dir> [port]
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

const site = resolve(process.argv[2] ?? 'site');
const port = Number(process.argv[3] ?? process.env.DEMO_SITE_PORT ?? 8698);
const PREFIX = '/NicotinD';

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith(PREFIX)) {
      let file = join(site, normalize(decodeURIComponent(pathname.slice(PREFIX.length))));
      if (file.startsWith(site) && existsSync(file) && statSync(file).isDirectory())
        file = join(file, 'index.html');
      if (file.startsWith(site) && existsSync(file) && statSync(file).isFile())
        return new Response(Bun.file(file));
    }
    const notFound = join(site, '404.html');
    return new Response(existsSync(notFound) ? Bun.file(notFound) : 'not found', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    });
  },
});
console.log(`serving ${site} at http://127.0.0.1:${port}${PREFIX}/`);
