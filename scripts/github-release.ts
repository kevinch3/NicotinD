#!/usr/bin/env bun
/**
 * The tag's GitHub Release, driven by id so a draft is as addressable as a
 * published one (docs/releasing.md "A release is published only once its
 * artifacts are attached").
 *
 *   bun run scripts/github-release.ts draft   --tag v1.2.3            → prints the release id
 *   bun run scripts/github-release.ts body    --id N --file notes.md
 *   bun run scripts/github-release.ts upload  --id N <file>...
 *   bun run scripts/github-release.ts publish --id N --tag v1.2.3 --expect <name>...
 *
 * WHY a script and not softprops/action-gh-release: deploy.yml used to publish
 * the release within seconds of the tag (release-notes created it) and attach
 * the APKs, IPA and desktop packages minutes later. For that window
 * `releases/latest` — what the in-app APK updater, electron-updater and the
 * F-Droid repo read — pointed at a release with nothing on it, and a failed
 * artifact job left it published without its files for good (v0.8.65). A draft
 * fixes both, but the action publishes an existing draft at the end of any step
 * that does not pass `draft: true`, and `/releases/tags/{tag}` cannot see a
 * draft at all. Addressing the release by id avoids both traps.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Release {
  id: number;
  tag_name: string;
  name?: string | null;
  draft: boolean;
  upload_url?: string;
  assets?: Array<{ id: number; name: string }>;
}

export interface Api {
  repo: string;
  token: string;
  fetch?: Fetch;
}

const API = 'https://api.github.com';

async function call<T>(api: Api, path: string, init: RequestInit = {}): Promise<T> {
  const res = await (api.fetch ?? fetch)(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${api.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.headers ?? {}),
    },
    // Every outbound fetch carries a deadline (check:fetch-timeouts).
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${res.status} ${res.statusText} for ${init.method ?? 'GET'} ${path}`,
    );
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/**
 * Every release for a tag, drafts included (the token must be able to see drafts).
 *
 * A draft is matched on its `name` as well: the API reports a draft's tag as
 * `untagged-<hash>` even when the tag exists, so `tag_name` alone never finds
 * the draft `ensureDraft` made (v0.8.103). That is also why nothing that looks
 * a release up by tag — electron-builder's publisher included — may upload to
 * it; everything goes by id.
 */
export async function releasesForTag(api: Api, tag: string): Promise<Release[]> {
  const found: Release[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await call<Release[]>(
      api,
      `/repos/${api.repo}/releases?per_page=100&page=${page}`,
    );
    found.push(...batch.filter((r) => r.tag_name === tag || (r.draft && r.name === tag)));
    if (batch.length < 100) return found;
  }
}

/**
 * The tag's release as a draft: reused if one exists, created if none does.
 *
 * More than one release for the tag is refused rather than picked from: v0.6.37
 * left a second, draft release sharing its tag, and a job choosing "the first"
 * uploads to one while another job reads the other. A release that is already
 * published (a re-run after publish) is returned as it is — attaching to it is
 * what a re-run of a failed artifact job should do.
 */
export async function ensureDraft(api: Api, tag: string): Promise<Release> {
  const existing = await releasesForTag(api, tag);
  if (existing.length > 1) {
    throw new Error(
      `${existing.length} releases share the tag ${tag} (ids ${existing.map((r) => r.id).join(', ')}). ` +
        `Delete the stray draft(s) by hand; uploading to one while readers see another is how ` +
        `v0.6.37 lost its desktop artifacts.`,
    );
  }
  if (existing[0]) return existing[0];
  return call<Release>(api, `/repos/${api.repo}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: tag, draft: true }),
  });
}

export async function setBody(api: Api, id: number, body: string): Promise<void> {
  await call(api, `/repos/${api.repo}/releases/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

/**
 * Attach one file, replacing a same-named asset first — a re-run of an
 * artifact job must converge, and GitHub rejects a duplicate name with a 422.
 */
export async function uploadAsset(api: Api, id: number, name: string, data: Blob): Promise<void> {
  const release = await call<Release>(api, `/repos/${api.repo}/releases/${id}`);
  for (const asset of release.assets ?? []) {
    if (asset.name === name) {
      await call(api, `/repos/${api.repo}/releases/assets/${asset.id}`, { method: 'DELETE' });
    }
  }
  await call(
    api,
    `https://uploads.github.com/repos/${api.repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      body: data,
      headers: { 'content-type': 'application/octet-stream' },
    },
  );
}

/**
 * Publish the draft, but only if every expected asset is on it, bound to `tag`.
 *
 * `tag_name` must be sent with the publish: the API reports a draft's tag as
 * `untagged-<hash>`, and flipping `draft` alone published v0.8.105–v0.8.108
 * under that placeholder, so `/releases/download/<tag>/…` — F-Droid's
 * `Binaries:` URL — 404ed (#1493). The draft's `name` is the tag it was made
 * for, so a mismatch means the wrong id and is refused before anything changes.
 *
 * `make_latest: legacy` lets GitHub pick "latest" by date and version, so a
 * release published late — its failed job re-run after a newer one shipped —
 * does not take `latest` from the newer one. A published release already bound
 * to its tag is left alone (idempotent re-run); one still untagged is re-bound,
 * which is also how the releases #1493 already shipped are repaired.
 */
export async function publish(
  api: Api,
  id: number,
  tag: string,
  expected: string[],
): Promise<Release> {
  const release = await call<Release>(api, `/repos/${api.repo}/releases/${id}`);
  if (release.name && release.name !== tag && release.tag_name !== tag) {
    throw new Error(
      `Release ${id} was made for ${release.name}, not ${tag}; refusing to publish it.`,
    );
  }
  const present = new Set((release.assets ?? []).map((a) => a.name));
  const missing = expected.filter((name) => !present.has(name)).sort();
  if (missing.length > 0) {
    throw new Error(
      `Release ${tag} is missing ${missing.length} expected asset(s), so it stays a ` +
        `draft:\n  ${missing.join('\n  ')}`,
    );
  }
  if (!release.draft && release.tag_name === tag) return release;
  const published = await call<Release>(api, `/repos/${api.repo}/releases/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(
      release.draft ? { tag_name: tag, draft: false, make_latest: 'legacy' } : { tag_name: tag },
    ),
  });
  if (published.tag_name !== tag) {
    throw new Error(
      `Release ${id} published as ${published.tag_name}, not ${tag}: /releases/download/${tag}/… ` +
        `would 404 (#1493).`,
    );
  }
  return published;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

/** Positional arguments: everything that is neither a `--flag` nor a flag's value. */
function positional(args: string[]): string[] {
  return args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const repo = flag(args, 'repo') ?? process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo) throw new Error('No repository: pass --repo owner/name or set GITHUB_REPOSITORY.');
  if (!token) throw new Error('No token: set GH_TOKEN (or GITHUB_TOKEN).');
  const api: Api = { repo, token };
  const id = Number(flag(args, 'id'));

  switch (command) {
    case 'draft': {
      const tag = flag(args, 'tag') ?? process.env.GITHUB_REF_NAME;
      if (!tag) throw new Error('No tag: pass --tag or set GITHUB_REF_NAME.');
      const release = await ensureDraft(api, tag);
      console.log(release.id);
      return;
    }
    case 'body': {
      const file = flag(args, 'file');
      if (!id || !file) throw new Error('body needs --id and --file.');
      await setBody(api, id, await Bun.file(file).text());
      return;
    }
    case 'upload': {
      const files = positional(args);
      if (!id || files.length === 0) throw new Error('upload needs --id and at least one file.');
      for (const path of files) {
        const name = path.split('/').pop()!;
        await uploadAsset(api, id, name, Bun.file(path));
        console.log(`uploaded ${name}`);
      }
      return;
    }
    case 'publish': {
      const expected = (flag(args, 'expect') ?? '').split(',').filter(Boolean);
      const tag = flag(args, 'tag') ?? process.env.GITHUB_REF_NAME;
      if (!id || !tag || expected.length === 0) {
        throw new Error('publish needs --id, --tag (or GITHUB_REF_NAME) and --expect a,b,c.');
      }
      const release = await publish(api, id, tag, expected);
      console.log(`${release.tag_name} is published (draft=${release.draft}).`);
      return;
    }
    default:
      throw new Error(`Unknown command ${command ?? '(none)'}: draft | body | upload | publish.`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
