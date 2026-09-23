import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TAG_LOADERS } from '../eslint.config.js';

// Through the real eslint.config.js: a restriction proven in a test config and never
// switched on is the safety feature nobody wired.
const repoRoot = resolve(import.meta.dir, '..');
const eslint = new ESLint({ cwd: repoRoot });

async function restricted(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => m.message);
}

const OTHER = 'packages/api/src/services/some-tagger.ts';

describe('one lazy loader per optional tag library (#1315)', () => {
  it('flags a local dynamic import, the shape compilation-tagger carried', async () => {
    for (const mod of Object.keys(TAG_LOADERS)) {
      expect(await restricted(`export const p = import('${mod}');\n`, OTHER)).toHaveLength(1);
    }
  });

  it('flags a static value import too', async () => {
    expect(
      await restricted("import nodeId3 from 'node-id3';\nnodeId3.read('x');\n", OTHER),
    ).toHaveLength(1);
  });

  it('allows a type-only import', async () => {
    expect(
      await restricted(
        "import type { IAudioMetadata } from 'music-metadata';\nexport type T = IAudioMetadata;\n",
        OTHER,
      ),
    ).toEqual([]);
  });

  it('lets each loader module import its own library and no other', async () => {
    const id3 = TAG_LOADERS['node-id3'];
    expect(await restricted("export const p = import('node-id3');\n", id3)).toEqual([]);
    expect(await restricted("export const p = import('music-metadata');\n", id3)).toHaveLength(1);
    const mm = TAG_LOADERS['music-metadata'];
    expect(await restricted("export const p = import('music-metadata');\n", mm)).toEqual([]);
  });

  it('leaves tests alone: they read the written bytes back directly', async () => {
    const test = 'packages/api/src/services/some-tagger.test.ts';
    expect(await restricted("export const p = import('node-id3');\n", test)).toEqual([]);
  });

  // The denominator: each exemption must still be the real loader, and the selector must
  // match the import shape that loader actually uses — or the rule watches nothing.
  it("fires on each loader's real source when it appears anywhere else", async () => {
    for (const [mod, file] of Object.entries(TAG_LOADERS)) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8');
      expect(source).toContain(`import('${mod}')`);
      const hits = await restricted(source, OTHER);
      expect({ mod, fires: hits.some((m) => m.includes(mod)) }).toEqual({ mod, fires: true });
    }
  });
});
