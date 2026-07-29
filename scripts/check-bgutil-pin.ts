/**
 * Guard the bgutil PO-token provider ↔ plugin version pairing (issue #238).
 *
 *   bun run check:bgutil-pin
 *
 * WHY: YouTube demands "proof of origin" tokens from unrecognized clients. Two
 * halves cooperate to supply them, and they live in different files built by
 * different systems:
 *
 *   Dockerfile                      pip `bgutil-ytdlp-pot-provider==X`  (baked into our image)
 *   packages/pot-provider/Dockerfile the server source tag we build from
 *
 * They must stay in step. A mismatch doesn't fail loudly — it silently breaks
 * YouTube acquisition, which is the exact hazard issue #238 opens with. Nothing
 * enforced the pairing; it was two literals kept together by comments.
 *
 * Since issue #238 the companion service is **our own image** built from pinned
 * upstream source, so the second half moved from a third-party compose tag into
 * `packages/pot-provider/Dockerfile`. That is strictly better for this gate: both
 * halves are now files in this repo, rather than one being an image tag whose
 * contents nobody here controls. `BGUTIL_VERSION` is a build-arg on both, so an
 * operator still moves one value; this checks that the two *baked defaults* agree.
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

/** The server build's default: `ARG BGUTIL_VERSION=1.3.1` in the provider image. */
export function composePin(providerDockerfile: string): string | null {
  return providerDockerfile.match(/^ARG\s+BGUTIL_VERSION=(\S+)/m)?.[1] ?? null;
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
    readFileSync(join(repoRoot, 'packages/pot-provider/Dockerfile'), 'utf8'),
  );

  if (ok) {
    console.log(`bgutil pin: pip plugin and provider image agree on ${docker}.`);
    return;
  }

  console.error('bgutil PO-token provider/plugin versions disagree:\n');
  console.error(`  Dockerfile  ARG BGUTIL_VERSION = ${docker ?? '(not found)'}`);
  console.error(`  pot-provider ARG BGUTIL_VERSION = ${compose ?? '(not found)'}`);
  console.error(
    '\nThe pip plugin and the companion service must be the same version — a\n' +
      'mismatch silently breaks YouTube downloads. Bump both, or set BGUTIL_VERSION.',
  );
  process.exit(1);
}

if (import.meta.main) main();
