/**
 * Print the paths of the artifacts electron-builder wrote that belong on the
 * GitHub Release, one per line, for deploy.yml's desktop upload step:
 *
 *   bun run packages/desktop/scripts/release-artifacts.ts | xargs bun scripts/github-release.ts upload --id N
 *
 * WHY not `electron-builder --publish always`: its GitHub publisher finds the
 * release by tag name, and the API reports a draft's tag as `untagged-…`, so it
 * never sees the draft `create-draft` made. With `releaseType: release` it then
 * creates — and publishes — a second release for the tag holding only the
 * desktop files, which becomes `latest` without the APKs (v0.8.103). Uploading
 * by release id, like the android and ios jobs, cannot miss the draft.
 *
 * The list is the same one verify-published-assets.ts checks afterwards
 * (`publishedArtifacts`), so what is uploaded and what is verified cannot drift.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { publishedArtifacts, RELEASE_DIR } from './verify-published-assets.js';

export function releaseArtifactPaths(dir: string, entries: string[]): string[] {
  return publishedArtifacts(entries).map((name) => join(dir, name));
}

if (import.meta.main) {
  const i = process.argv.indexOf('--dir');
  const dir = i === -1 ? RELEASE_DIR : process.argv[i + 1]!;
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  const paths = releaseArtifactPaths(dir, files);
  // An empty list would make the upload step fail with a usage error; say why here.
  if (paths.length === 0) {
    console.error(`❌ electron-builder wrote no publishable artifact to ${dir}.`);
    process.exit(1);
  }
  console.log(paths.join('\n'));
}
