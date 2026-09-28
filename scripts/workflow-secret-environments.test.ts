import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Every job that reads a deploy, signing, release or bot credential runs in the
 * environment that holds it (docs/dependency-management.md "Secrets live in
 * environments").
 *
 * A repository secret is readable by any workflow on any branch: a branch that
 * adds a `push`-triggered workflow can print it, and this repo has hundreds of
 * branches, many pushed by automated sessions. An environment secret is only
 * handed to a job that names the environment, and the environment's deployment
 * rule decides which refs may. The binding lives in the workflow; the rule
 * lives in the repository settings, which no test can read — hence the doc.
 *
 * Checked in both directions per secret, so a new job reading one of these
 * without the environment fails, and so does a renamed secret this table no
 * longer matches anywhere.
 */
const REQUIRED_ENVIRONMENT: Record<string, string> = {
  RELEASE_TOKEN: 'release',
  DEPLOY_HOST: 'production',
  DEPLOY_USER: 'production',
  TS_OAUTH_CLIENT_ID: 'production',
  TS_OAUTH_SECRET: 'production',
  ANDROID_KEYSTORE_BASE64: 'release-signing',
  ANDROID_KEYSTORE_PASSWORD: 'release-signing',
  ANDROID_KEY_ALIAS: 'release-signing',
  ANDROID_KEY_PASSWORD: 'release-signing',
  FDROID_REPO_KEYSTORE_BASE64: 'github-pages',
  FDROID_REPO_KEYSTORE_PASSWORD: 'github-pages',
  FDROID_REPO_KEY_ALIAS: 'github-pages',
  RENOVATE_TOKEN: 'renovate',
};

type Job = { environment?: string | { name?: string }; [k: string]: unknown };

const dir = join(import.meta.dir, '..', '.github', 'workflows');
const jobs = readdirSync(dir)
  .filter((f) => f.endsWith('.yml'))
  .flatMap((file) =>
    Object.entries(
      (parse(readFileSync(join(dir, file), 'utf8')) as { jobs: Record<string, Job> }).jobs,
    ).map(([name, job]) => ({ file, name, job })),
  );

const envOf = (job: Job): string | undefined =>
  typeof job.environment === 'string' ? job.environment : job.environment?.name;

const secretsIn = (job: Job): string[] => [
  ...new Set([...JSON.stringify(job).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]!)),
];

describe('credentials are only read from inside their environment', () => {
  for (const { file, name, job } of jobs) {
    const scoped = secretsIn(job).filter((s) => s in REQUIRED_ENVIRONMENT);
    if (scoped.length === 0) continue;
    it(`${file} › ${name} runs in the environment holding ${scoped.join(', ')}`, () => {
      for (const secret of scoped) {
        expect({ secret, environment: envOf(job) }).toEqual({
          secret,
          environment: REQUIRED_ENVIRONMENT[secret],
        });
      }
    });
  }

  it('every secret in the table is still read somewhere', () => {
    const read = new Set(jobs.flatMap(({ job }) => secretsIn(job)));
    expect(Object.keys(REQUIRED_ENVIRONMENT).filter((s) => !read.has(s))).toEqual([]);
  });
});
