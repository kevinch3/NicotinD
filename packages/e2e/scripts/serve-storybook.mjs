/**
 * Serve the built Storybook on a fixed port, for the visual regression project
 * (playwright.storybook.config.ts). The gates use the same `serve()` on an
 * ephemeral port; Playwright's `webServer` needs one it can name in advance.
 */
import { serve } from './lib/storybook-runner.mjs';

const port = Number(process.env.STORYBOOK_VISUAL_PORT ?? 6116);
const server = await serve(port);
console.log(`storybook-static on http://127.0.0.1:${server.address().port}`);
