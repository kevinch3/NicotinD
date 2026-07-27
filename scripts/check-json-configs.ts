/**
 * Fail on duplicate keys in the JSON config files.
 *
 *   bun run check:json
 *
 * WHY: `JSON.parse` accepts duplicate keys and silently keeps the **last** one.
 * That makes a whole class of damage invisible — most realistically from a merge
 * resolved by keeping both sides of a conflict, which is the natural resolution
 * for the additive edits this repo's config files actually get.
 *
 * Found empirically, not hypothesised: merging the open PR queue produced
 *
 *     "typecheck": "tsc --build && … typecheck:template",
 *     "typecheck": "tsc --build",
 *
 * in package.json. `JSON.parse` reported it as valid, and the *second* line won
 * — silently discarding the Angular-template type-check that the PR adding it
 * exists to introduce. Only `bun`'s own parser warned, and only in passing.
 *
 * The i18n catalogs are covered for the same reason: a duplicate key there
 * silently drops a translation, and the base catalog is meant to be a clean
 * artefact a translation provider can import.
 *
 * A gate rather than a report (unlike check-shipped-issues.ts): a duplicate key
 * is never intentional, so there is no false-positive class to cry wolf with.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { Glob } from 'bun';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Strict-JSON files this gate covers. tsconfigs are excluded — they are JSONC. */
export const CONFIG_PATHS = [
  'package.json',
  'packages/web/angular.json',
  'packages/web/ngsw-config.json',
] as const;

/**
 * Globs expanded on top of {@link CONFIG_PATHS}. The i18n catalogs are here for
 * the same reason as the manifests: a duplicate key silently drops a
 * translation, and the base catalog is meant to be a clean artefact a
 * translation provider can import.
 */
export const CONFIG_GLOBS = ['packages/*/package.json', 'packages/web/public/i18n/*.json'] as const;

/** Existing files matching {@link CONFIG_PATHS} + {@link CONFIG_GLOBS}. */
export function configFiles(root = repoRoot): string[] {
  const globbed = CONFIG_GLOBS.flatMap((g) => [...new Glob(g).scanSync(root)]);
  return [...new Set([...CONFIG_PATHS, ...globbed])]
    .filter((f) => existsSync(join(root, f)))
    .sort();
}

/**
 * Duplicate keys in one JSON document, as `path.to.key` strings.
 *
 * Hand-scanned rather than done with a `JSON.parse` reviver, because the
 * reviver **cannot** see this: the parser resolves duplicates while building
 * the object, so the reviver is called once per *surviving* member, never per
 * source member. (Established by test, after the reviver version silently
 * reported zero duplicates on a document that had them.)
 *
 * The scan only needs to know where object keys are, so it tracks string
 * literals (with escapes), container nesting, and whether the next string is in
 * key position — not full JSON semantics. Values are irrelevant here.
 */
export function duplicateKeys(source: string): string[] {
  // Fail loudly on malformed input rather than scanning nonsense.
  JSON.parse(source);

  const dupes: string[] = [];
  type Frame = { isObject: boolean; keys: Set<string>; path: string; lastKey: string };
  const stack: Frame[] = [];
  let i = 0;
  // A string is a key when it is the next token inside an object and we are not
  // already past that object member's colon.
  let expectKey = false;

  const top = (): Frame | undefined => stack[stack.length - 1];

  while (i < source.length) {
    const ch = source[i];

    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          text += source[j + 1];
          j += 2;
          continue;
        }
        text += source[j];
        j++;
      }
      const frame = top();
      if (frame?.isObject && expectKey) {
        if (frame.keys.has(text)) {
          dupes.push(frame.path ? `${frame.path}.${text}` : text);
        }
        frame.keys.add(text);
        frame.lastKey = text;
        expectKey = false;
      }
      i = j + 1;
      continue;
    }

    if (ch === '{' || ch === '[') {
      const parent = top();
      const path = parent
        ? parent.isObject
          ? parent.path
            ? `${parent.path}.${parent.lastKey}`
            : parent.lastKey
          : parent.path
        : '';
      stack.push({ isObject: ch === '{', keys: new Set(), path, lastKey: '' });
      expectKey = ch === '{';
      i++;
      continue;
    }

    if (ch === '}' || ch === ']') {
      stack.pop();
      expectKey = false;
      i++;
      continue;
    }

    // A comma inside an object means the next string is a key again.
    if (ch === ',') {
      expectKey = top()?.isObject ?? false;
      i++;
      continue;
    }

    i++;
  }

  return dupes;
}

function main(): void {
  const problems: Array<{ file: string; keys: string[] }> = [];

  for (const file of configFiles()) {
    let dupes: string[];
    try {
      dupes = duplicateKeys(readFileSync(join(repoRoot, file), 'utf8'));
    } catch (err) {
      console.error(`${file}: not valid JSON — ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    if (dupes.length) problems.push({ file, keys: dupes });
  }

  if (!problems.length) {
    console.log(`JSON configs: ${configFiles().length} files checked, no duplicate keys.`);
    return;
  }

  console.error('Duplicate keys found — JSON.parse keeps the LAST one silently:\n');
  for (const p of problems) {
    console.error(`  ${p.file}`);
    for (const k of p.keys) console.error(`    · ${k}`);
  }
  console.error(
    '\nUsually a merge resolved by keeping both sides of a conflict. Keep the\n' +
      'intended definition, not both — the other one is being discarded already.',
  );
  process.exit(1);
}

if (import.meta.main) main();
