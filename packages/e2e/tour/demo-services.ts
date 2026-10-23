/**
 * Boots the tour's two stand-in services in one process — the demo Lidarr and
 * the demo acquisition addon — for `playwright.tour.config.ts` to start as a
 * webServer ahead of NicotinD (which reads the Lidarr URL at boot).
 */
import { startDemoAddon } from './demo-addon.js';
import { startDemoLidarr } from './demo-lidarr.js';

export const DEMO_LIDARR_PORT = Number(process.env.DEMO_LIDARR_PORT ?? 8691);
export const DEMO_ADDON_PORT = Number(process.env.DEMO_ADDON_PORT ?? 8692);

if (import.meta.main) {
  await startDemoLidarr(DEMO_LIDARR_PORT);
  await startDemoAddon(DEMO_ADDON_PORT);
  console.log(`demo lidarr :${DEMO_LIDARR_PORT}, demo addon :${DEMO_ADDON_PORT}`);
}
