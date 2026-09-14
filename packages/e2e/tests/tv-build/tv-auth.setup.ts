import { test as setup } from '@playwright/test';
import { seedAdminAndLibrary } from '../../helpers';

/** Where the `tv` project's authenticated storageState lives. */
export const TV_AUTH_FILE = '.auth/tv-admin.json';

/**
 * Setup for the `tv` project (#1136): the TV-configuration bundle runs on its
 * own managed server, so it needs its own admin, scan and storageState — the
 * same baseline `auth.setup.ts` gives the phone server, from the same helper.
 */
setup('seed the TV server: admin + library', async ({ page, request }) => {
  await seedAdminAndLibrary(page, request, TV_AUTH_FILE);
});
