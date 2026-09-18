/**
 * Which entries differ between two APKs?
 *
 *   bun run packages/mobile/scripts/apk-diff.ts <reference.apk> <candidate.apk>
 *
 * Exits non-zero when anything but the signature differs — so this is usable as
 * a check, not only as a diagnostic. See docs/fdroid.md "Reproducible builds"
 * for the procedure this fits into (F-Droid's own verifier is apksigcopier +
 * `apksigner verify`, which reports *that* two APKs differ but never *where*).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  diffApkEntries,
  formatApkDiff,
  isIdentical,
  parseZipinfoMethods,
  parseZipinfoNames,
  type ApkEntries,
  type ApkEntry,
} from '../src/apk-diff.js';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function run(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    fail(`${cmd} ${args.join(' ')} failed: ${res.stderr || res.error?.message || res.status}`);
  }
  return res.stdout;
}

/** Every file under `dir`, relative and slash-separated. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: true, dot: true })) {
    out.push(relative(base, join(dir, e)).split('\\').join('/'));
  }
  return out;
}

function readApk(apk: string): { entries: ApkEntries; order: string[] } {
  if (!statSync(apk, { throwIfNoEntry: false })) fail(`no such file: ${apk}`);
  const dir = mkdtempSync(join(tmpdir(), 'apk-diff-'));
  try {
    run('unzip', ['-q', '-o', '-d', dir, apk]);
    const methods = parseZipinfoMethods(run('zipinfo', ['-l', apk]));
    const entries = new Map<string, ApkEntry>();
    for (const name of walk(dir)) {
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(readFileSync(join(dir, name)));
      entries.set(name, { sha256: hasher.digest('hex'), method: methods.get(name) });
    }
    return { entries, order: parseZipinfoNames(run('zipinfo', ['-1', apk])) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const [refPath, candPath] = process.argv.slice(2);
if (!refPath || !candPath) {
  fail('usage: bun run packages/mobile/scripts/apk-diff.ts <reference.apk> <candidate.apk>');
}

const a = readApk(resolve(refPath));
const b = readApk(resolve(candPath));
const diff = diffApkEntries(a.entries, b.entries, { a: a.order, b: b.order });

console.log(`reference: ${refPath}`);
console.log(`candidate: ${candPath}`);
console.log(formatApkDiff(diff));

process.exit(isIdentical(diff) ? 0 : 1);
