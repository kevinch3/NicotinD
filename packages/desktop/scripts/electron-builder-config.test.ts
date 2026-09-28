import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

// electron-builder's own critical-path validation (app-builder-lib's
// appImageUtil.validateCriticalPathString): Unicode letters/digits/dots/
// underscores/hyphens/spaces only. A scoped npm package name like
// `@nicotind/desktop` fails it once `/` is stripped, leaving `@` behind.
const SAFE_FILENAME_FIELD = /^[\p{L}\p{N}._\- ]+$/u;

const config = parse(readFileSync(path.join(import.meta.dir, '../electron-builder.yml'), 'utf-8'));

describe('electron-builder.yml', () => {
  it('pins executableName to a value electron-builder accepts (regression: v26 rejects the scoped package name fallback)', () => {
    expect(config.executableName).toBeTruthy();
    expect(config.executableName).toMatch(SAFE_FILENAME_FIELD);
  });

  it('pins deb.artifactName off productName, not the scoped package name', () => {
    expect(config.deb.artifactName).toBe('${productName}_${version}_${arch}.${ext}');
  });

  // Regression #1261: with the default `draft`, the publisher refused to upload
  // into the published release deploy.yml used to create first — skipping every
  // file and exiting 0 for two months. The release is now a draft the publisher
  // always uses; this pin decides what it does if that draft is ever missing.
  it('pins publish.releaseType to release, so the publisher matches the release deploy.yml creates', () => {
    expect(config.publish.provider).toBe('github');
    expect(config.publish.releaseType).toBe('release');
  });
});
