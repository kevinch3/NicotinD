/**
 * Guard the bgutil PO-token provider ↔ plugin version pairing (issue #238).
 *
 *   bun run check:bgutil-pin
 *
 * WHY: YouTube demands "proof of origin" tokens from unrecognized clients. Two
 * halves cooperate to supply them, and they live in different files built by
 * different systems:
 *
 *   Dockerfile         pip `bgutil-ytdlp-pot-provider==X`  (baked into our image)
 *   docker-compose.yml `brainicism/bgutil-ytdlp-pot-provider:X` (companion service)
 *
 * They must stay in step. A mismatch doesn't fail loudly — it silently breaks
 * YouTube acquisition, which is the exact hazard issue #238 opens with. Nothing
 * enforced the pairing; it was two literals kept together by comments.
 *
 * `BGUTIL_VERSION` now overrides both at deploy time (a build-arg in the
 * Dockerfile, compose interpolation in the service), so an operator moves one
 * value. This checks the remaining risk: that the two *baked defaults* drift.
 *
 * A gate rather than a report (unlike check-shipped-issues.ts): there is exactly
 * one correct answer — the two strings are equal or they are not — so there is
 * no false-positive class to cry wolf with.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** The pip pin's default: `ARG BGUTIL_VERSION=1.3.1`. */
export function dockerfilePin(dockerfile: string): string | null {
  return dockerfile.match(/^ARG\s+BGUTIL_VERSION=(\S+)/m)?.[1] ?? null;
}

/** The compose image tag's fallback: `…provider:${BGUTIL_VERSION:-1.3.1}`. */
export function composePin(compose: string): string | null {
  return (
    compose.match(
      /image:\s*brainicism\/bgutil-ytdlp-pot-provider:\$\{BGUTIL_VERSION:-([^}]+)\}/,
    )?.[1] ?? null
  );
}

/** Both defaults, and whether they agree. */
export function comparePins(
  dockerfile: string,
  compose: string,
): { docker: string | null; compose: string | null; ok: boolean } {
  const d = dockerfilePin(dockerfile);
  const c = composePin(compose);
  // A missing pin is a failure, not a pass — someone removed the plumbing.
  return { docker: d, compose: c, ok: d !== null && c !== null && d === c };
}

function main(): void {
  const { docker, compose, ok } = comparePins(
    readFileSync(join(repoRoot, 'Dockerfile'), 'utf8'),
    readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8'),
  );

  if (ok) {
    console.log(`bgutil pin: Dockerfile and docker-compose.yml agree on ${docker}.`);
    return;
  }

  console.error('bgutil PO-token provider/plugin versions disagree:\n');
  console.error(`  Dockerfile  ARG BGUTIL_VERSION = ${docker ?? '(not found)'}`);
  console.error(`  compose     image tag default  = ${compose ?? '(not found)'}`);
  console.error(
    '\nThe pip plugin and the companion service must be the same version — a\n' +
      'mismatch silently breaks YouTube downloads. Bump both, or set BGUTIL_VERSION.',
  );
  process.exit(1);
}

if (import.meta.main) main();
