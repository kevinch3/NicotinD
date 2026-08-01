import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '../../..');
const SOURCE = resolve(ROOT, 'CHANGELOG.md');
const OUT = resolve(SCRIPT_DIR, '../public/changelog.json');

const MAX_VERSIONS = 50;

export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  compareUrl: string;
  sections: ChangelogSection[];
}

export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const headerRe = /^## \[([^\]]+)\]\(([^)]+)\)\s*(?:\(([^)]+)\))?/m;
  const blocks = md.split(/^## \[/m).slice(1);

  for (const block of blocks) {
    const full = '## [' + block;
    const headerMatch = full.match(headerRe);
    if (!headerMatch) continue;

    const version = headerMatch[1];
    const compareUrl = headerMatch[2];
    const date = headerMatch[3] ?? '';
    const body = full.slice(headerMatch[0].length);

    const sections: ChangelogSection[] = [];
    const sectionBlocks = body.split(/^### /m).slice(1);

    for (const sBlock of sectionBlocks) {
      const lines = sBlock.split('\n');
      const title = lines[0].trim();
      const items = lines
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('* '))
        .map((l) => l.slice(2).trim());
      if (title) sections.push({ title, items });
    }

    entries.push({ version, date, compareUrl, sections });
  }

  return entries;
}

/** The exact bytes `main()` writes to `changelog.json` for a given `CHANGELOG.md` source
 * (or `undefined` source, mirroring the "file not found" branch). Pure — no filesystem access. */
export function buildChangelogJson(md: string | undefined): string {
  if (md === undefined) return '[]\n';
  const entries = parseChangelog(md).slice(0, MAX_VERSIONS);
  return JSON.stringify(entries, null, 2) + '\n';
}

/** Writes `content` to `outPath` only if it differs from what's already there (or nothing is
 * there yet) — so a no-op regeneration (the common case: `CHANGELOG.md` unchanged since the file
 * was last committed) doesn't touch mtime or dirty the git working tree. Returns whether it wrote. */
export function writeIfChanged(outPath: string, content: string): boolean {
  mkdirSync(dirname(outPath), { recursive: true });
  if (existsSync(outPath) && readFileSync(outPath, 'utf8') === content) return false;
  writeFileSync(outPath, content, 'utf8');
  return true;
}

function main() {
  const md = existsSync(SOURCE) ? readFileSync(SOURCE, 'utf8') : undefined;
  const content = buildChangelogJson(md);
  const wrote = writeIfChanged(OUT, content);

  if (md === undefined) {
    console.log(
      wrote
        ? 'changelog.json: CHANGELOG.md not found, wrote empty array'
        : 'changelog.json: CHANGELOG.md not found, already an empty array — skipped write',
    );
    return;
  }

  const versions = JSON.parse(content).length;
  console.log(
    wrote
      ? `changelog.json: ${versions} versions written`
      : `changelog.json: ${versions} versions, unchanged — skipped write`,
  );
}

if (import.meta.main) main();
