/**
 * Assembles our own signed F-Droid repository from the F-Droid-variant APKs of
 * the current release, ready to publish as a static directory (issue #1168).
 *
 *   FDROID_REPO_URL=https://kevinch3.github.io/NicotinD/fdroid/repo \
 *   FDROID_REPO_KEYSTORE=/path/to/repo.keystore \
 *   FDROID_REPO_KEYSTORE_PASSWORD=… FDROID_REPO_KEY_ALIAS=… \
 *   bun run scripts/build-fdroid-repo.ts <apk-dir> <out-dir>
 *
 * `<apk-dir>` holds the release's F-Droid APKs under the names in
 * {@link FDROID_APPS}; `<out-dir>` is created and filled with what a web server
 * should serve.
 *
 * It only ever publishes the CURRENT release. An F-Droid repository is valid
 * with one version per app — the client offers what the index lists — so
 * nothing has to be carried between runs. That is what keeps this stateless:
 * no repo history to check out, restore or accumulate, and a re-run of a
 * release reproduces the same repository.
 *
 * Requires `fdroid` (fdroidserver) and an Android SDK for apksigner. Verified
 * locally against fdroidserver 2.4.5.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  FDROID_APPS,
  fdroidAppMetadata,
  fdroidRepoConfig,
} from '../packages/mobile/src/fdroid-repo.js';
import { androidVersion } from '../packages/mobile/src/version.js';

const repoRoot = resolve(import.meta.dir, '..');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const [apkDirArg, outDirArg] = process.argv.slice(2);
if (!apkDirArg || !outDirArg) {
  throw new Error('usage: build-fdroid-repo.ts <apk-dir> <out-dir>');
}
const apkDir = resolve(apkDirArg);
const outDir = resolve(outDirArg);

const repoUrl = required('FDROID_REPO_URL');
const keystoreSrc = resolve(required('FDROID_REPO_KEYSTORE'));
const keystorePassword = required('FDROID_REPO_KEYSTORE_PASSWORD');
const keyAlias = required('FDROID_REPO_KEY_ALIAS');

const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};
const { versionCode } = androidVersion(version);

// Fail before doing any work if an APK is missing, rather than publishing a
// repository that silently offers one app. `fdroid update` would happily build
// an index from whatever is present.
const missing = FDROID_APPS.filter((app) => !existsSync(join(apkDir, app.apk)));
if (missing.length > 0) {
  throw new Error(
    `missing APK(s) in ${apkDir}: ${missing.map((a) => a.apk).join(', ')}. ` +
      'Every app in FDROID_APPS must have one, or the published repository ' +
      'would drop an entry without failing.',
  );
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'repo'), { recursive: true });

// The keystore is copied in because fdroid resolves `keystore:` relative to the
// working directory; 0600 so it is not group/world readable in the workspace.
const keystore = 'repo-signing.keystore';
cpSync(keystoreSrc, join(outDir, keystore));
chmodSync(join(outDir, keystore), 0o600);

const configPath = join(outDir, 'config.yml');
writeFileSync(configPath, fdroidRepoConfig({ repoUrl, keystore, keystorePassword, keyAlias }));
chmodSync(configPath, 0o600); // carries the keystore password

for (const app of FDROID_APPS) {
  cpSync(join(apkDir, app.apk), join(outDir, 'repo', app.apk));

  const metadataDir = join(outDir, 'metadata', app.applicationId);
  mkdirSync(metadataDir, { recursive: true });
  // The fastlane tree, per locale. `images/README.md` documents the missing
  // screenshots for a human and would otherwise be copied into the index.
  cpSync(join(repoRoot, app.fastlaneDir, 'metadata/android'), metadataDir, {
    recursive: true,
    filter: (src) => !src.endsWith('README.md'),
  });
  writeFileSync(
    join(outDir, 'metadata', `${app.applicationId}.yml`),
    fdroidAppMetadata(app, versionCode),
  );
}

// The repo's own icon, shown when a user adds the repository. `repo_icon` is a
// path relative to fdroid's WORKING directory, and fdroid copies it into
// repo/icons/ itself — so the source belongs next to config.yml, not in repo/.
// Worth stating because the warning misleads: it reads
// `repo_icon "repo/icons/icon.png" does not exist` while the existence check is
// on the source path (update.py's `if os.path.exists(repo_icon)`). Putting a
// stray PNG in repo/ instead gets it published as an app file with no metadata.
cpSync(join(repoRoot, 'fastlane/metadata/android/en-US/images/icon.png'), join(outDir, 'icon.png'));

// NOT --create-metadata: it would invent a metadata file whose Name (the APK
// label, identical for both entries) outranks our fastlane title.txt.
const result = spawnSync('fdroid', ['update', '--pretty'], { cwd: outDir, stdio: 'inherit' });
if (result.error) throw new Error(`fdroid update failed to spawn: ${result.error.message}`);
if (result.status !== 0) throw new Error(`fdroid update failed (exit ${result.status})`);

// Never publish the signing key or the password-bearing config, whatever the
// caller does with outDir next.
rmSync(join(outDir, keystore), { force: true });
rmSync(configPath, { force: true });
rmSync(join(outDir, 'tmp'), { recursive: true, force: true });

const index = join(outDir, 'repo', 'index-v2.json');
if (!existsSync(index)) throw new Error(`fdroid update produced no ${index}`);
const parsed = JSON.parse(readFileSync(index, 'utf8')) as { packages: Record<string, unknown> };
const published = Object.keys(parsed.packages);
for (const app of FDROID_APPS) {
  if (!published.includes(app.applicationId)) {
    throw new Error(
      `${app.applicationId} is absent from the generated index. fdroid update ` +
        'exits 0 after skipping an APK it could not read, so the index is the ' +
        'only honest confirmation that both entries published.',
    );
  }
}

console.log(`\nF-Droid repository at ${outDir}/repo — ${published.join(', ')} @ ${version}`);
