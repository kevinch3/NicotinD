import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const SOURCE = resolve(ROOT, 'CHANGELOG.md');
const OUT = resolve(import.meta.dir, '../public/changelog.json');

const MAX_VERSIONS = 50;

interface ChangelogSection {
  title: string;
  items: string[];
}

interface ChangelogEntry {
  version: string;
  date: string;
  compareUrl: string;
  sections: ChangelogSection[];
}

function parseChangelog(md: string): ChangelogEntry[] {
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

function main() {
  mkdirSync(dirname(OUT), { recursive: true });

  if (!existsSync(SOURCE)) {
    writeFileSync(OUT, '[]\n', 'utf8');
    console.log('changelog.json: CHANGELOG.md not found, wrote empty array');
    return;
  }

  const md = readFileSync(SOURCE, 'utf8');
  const entries = parseChangelog(md).slice(0, MAX_VERSIONS);
  writeFileSync(OUT, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  console.log(`changelog.json: ${entries.length} versions written`);
}

main();
