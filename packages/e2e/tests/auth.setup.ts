import { test as setup } from '@playwright/test';
import { AUTH_FILE, seedAdminAndLibrary } from '../helpers';

/**
 * Setup project (runs before every other project). Seeds the admin user, kicks a
 * library scan of the committed fixtures, and saves an authenticated
 * storageState that the chromium project reuses. The body is
 * `seedAdminAndLibrary`, shared with the TV bundle's `tv-setup` project (#1136).
 */
setup('seed admin + library', async ({ page, request }) => {
  await seedAdminAndLibrary(page, request, AUTH_FILE);
});
