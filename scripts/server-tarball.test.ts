import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SERVER_EXTRA_FILES,
  overBudget,
  serverTarballArch,
  serverTarballName,
  smokeEnv,
} from './server-tarball';

const ROOT = resolve(import.meta.dir, '..');

describe('server tarball (#1742)', () => {
  it('names the tarball by version and arch', () => {
    expect(serverTarballName('0.8.127', 'x64')).toBe('nicotind-0.8.127-server-linux-x64.tar.gz');
    expect(serverTarballName('0.8.127', 'arm64')).toBe(
      'nicotind-0.8.127-server-linux-arm64.tar.gz',
    );
  });

  it('builds only the two Linux arches the release ships', () => {
    expect(serverTarballArch('x64')).toBe('x64');
    expect(serverTarballArch('arm64')).toBe('arm64');
    expect(() => serverTarballArch('ia32')).toThrow(/x64 or arm64/);
  });

  it('ships the first-run Lidarr download, which embedded mode runs from scripts/', () => {
    // main.ts execs ../scripts/download-deps.ts in embedded mode; a tarball
    // without it would crash on the default mode's first start.
    expect(SERVER_EXTRA_FILES).toContain('scripts/download-deps.ts');
    for (const f of SERVER_EXTRA_FILES) expect(existsSync(join(ROOT, f))).toBe(true);
  });

  it('carries every relative import of the shipped scripts', async () => {
    for (const f of SERVER_EXTRA_FILES.filter((x) => x.endsWith('.ts'))) {
      const src = await Bun.file(join(ROOT, f)).text();
      for (const m of src.matchAll(/from '\.\/([^']+)\.js'/g)) {
        expect(SERVER_EXTRA_FILES).toContain(`scripts/${m[1]}.ts`);
      }
    }
  });

  it('fails a tarball over its size ceiling, and passes one under it', () => {
    expect(overBudget(90 * 1024 * 1024, 80)).toBe(true);
    expect(overBudget(70 * 1024 * 1024, 80)).toBe(false);
  });

  it('smoke-starts without Lidarr, in its own data and music dirs', () => {
    const env = smokeEnv('/tmp/x', 18999);
    expect(env.NICOTIND_MODE).toBe('external');
    expect(env.NICOTIND_PORT).toBe('18999');
    expect(env.NICOTIND_DATA_DIR).toBe('/tmp/x/data');
    expect(env.NICOTIND_MUSIC_DIR).toBe('/tmp/x/music');
    expect(env.NICOTIND_LIDARR_URL).toBeUndefined();
  });
});
