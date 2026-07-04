import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Regression guard for: "changelog modal is empty in the browser webapp".
// The webapp is served from the Docker image. `build-changelog.ts` reads the
// repo-root CHANGELOG.md at web-build time and bakes it into a static JSON
// import; if the file is absent from the Docker build context it silently
// writes `[]` and the modal renders empty. Two things must hold for the file
// to reach the build: `.dockerignore` must not exclude it, and the Dockerfile's
// web-builder stage must COPY it in before `bun run build`.

// vitest runs with cwd = packages/web; repo root is two levels up.
const REPO_ROOT = resolve(process.cwd(), '../..');

// Minimal emulation of Docker's per-line, last-match-wins ignore evaluation.
function matchDockerPattern(pattern: string, path: string): boolean {
  const regex = pattern
    .split('/')
    .map((seg) =>
      seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*+/g, (stars) => (stars.length >= 2 ? '.*' : '[^/]*')),
    )
    .join('/');
  return new RegExp(`^${regex}$`).test(path);
}

function isIncludedByDockerignore(dockerignore: string, path: string): boolean {
  let included = true;
  for (const raw of dockerignore.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const pattern = negate ? line.slice(1) : line;
    if (matchDockerPattern(pattern, path)) included = negate;
  }
  return included;
}

describe('Docker build context provisions CHANGELOG.md', () => {
  it('.dockerignore keeps CHANGELOG.md in the build context', () => {
    const dockerignore = readFileSync(resolve(REPO_ROOT, '.dockerignore'), 'utf8');
    expect(isIncludedByDockerignore(dockerignore, 'CHANGELOG.md')).toBe(true);
  });

  it('Dockerfile copies CHANGELOG.md into the web-builder stage before building', () => {
    const dockerfile = readFileSync(resolve(REPO_ROOT, 'Dockerfile'), 'utf8');
    const webBuilder = dockerfile.slice(
      dockerfile.indexOf('AS web-builder'),
      dockerfile.indexOf('AS production'),
    );
    const copyIdx = webBuilder.search(/^COPY\s+CHANGELOG\.md\b/m);
    const buildIdx = webBuilder.search(/bun run build/);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeLessThan(buildIdx);
  });
});
