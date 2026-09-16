/**
 * Writes the landing page for the GitHub Pages site (issue #1168).
 *
 *   bun run scripts/build-pages-index.ts <site-dir>
 *
 * The site holds two unrelated things — the component catalog and our F-Droid
 * repository — so the root needs to say what they are. Without it, trimming the
 * URL to the host gives a 404, and the repository address (the one thing a user
 * has to copy by hand) is undiscoverable.
 *
 * It describes what is actually in `<site-dir>`, not what is supposed to be:
 * the F-Droid half is skipped when the signing key is absent, and a page that
 * advertised a repository that is not there would be worse than one that does
 * not mention it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const siteDir = resolve(process.argv[2] ?? 'site');
const repoRoot = resolve(import.meta.dir, '..');
const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};

const hasCatalog = existsSync(join(siteDir, 'storybook', 'index.html'));
const hasFdroid = existsSync(join(siteDir, 'fdroid', 'repo', 'index-v2.json'));

/** Absolute, because a user pastes it into an F-Droid client, not a browser. */
const repoUrl = `${process.env.PAGES_BASE_URL ?? 'https://kevinch3.github.io/NicotinD'}/fdroid/repo`;

const fdroidSection = hasFdroid
  ? `    <section>
      <h2>F-Droid repository</h2>
      <p>Add this address in an F-Droid client to install NicotinD and NicotinD TV:</p>
      <p><code>${repoUrl}</code></p>
      <p class="note">
        These builds carry no proprietary dependencies and no self-updater — F-Droid
        updates them. They are signed with the project release key; the repository index
        is signed with a separate key held only by CI.
      </p>
      <p><a href="fdroid/repo/">Browse the repository</a></p>
    </section>`
  : '';

const catalogSection = hasCatalog
  ? `    <section>
      <h2>Component catalog</h2>
      <p>The web UI's shared components, as they exist on <code>master</code>.</p>
      <p><a href="storybook/">Open Storybook</a></p>
    </section>`
  : '';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NicotinD</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0 auto; padding: 3rem 1.25rem; max-width: 42rem;
        font: 16px/1.6 system-ui, -apple-system, sans-serif;
      }
      h1 { margin-bottom: .25rem; }
      .tagline { margin-top: 0; opacity: .75; }
      section { margin-top: 2.5rem; }
      h2 { font-size: 1.1rem; margin-bottom: .5rem; }
      code {
        display: inline-block; padding: .4rem .6rem; border-radius: .35rem;
        background: color-mix(in srgb, currentColor 10%, transparent);
        font-size: .9rem; word-break: break-all;
      }
      .note { font-size: .9rem; opacity: .75; }
      footer { margin-top: 3rem; font-size: .9rem; opacity: .7; }
    </style>
  </head>
  <body>
    <h1>NicotinD</h1>
    <p class="tagline">A self-hosted music server that finds the music too.</p>
${[fdroidSection, catalogSection].filter(Boolean).join('\n')}
    <footer>
      Version ${version} &middot; AGPL-3.0-only &middot;
      <a href="https://github.com/kevinch3/NicotinD">Source on GitHub</a>
    </footer>
  </body>
</html>
`;

writeFileSync(join(siteDir, 'index.html'), html);
console.log(
  `site index written: catalog=${hasCatalog ? 'yes' : 'no'} fdroid=${hasFdroid ? 'yes' : 'no'}`,
);
