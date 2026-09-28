import { describe, expect, it } from 'bun:test';
import { ensureDraft, publish, uploadAsset, type Api, type Release } from './github-release';

/**
 * A fake GitHub releases API: enough state to prove the draft lifecycle
 * (create-or-reuse, overwrite-on-upload, publish-only-when-complete) without
 * the network.
 */
function fakeGitHub(initial: Release[] = []) {
  const releases: Release[] = structuredClone(initial);
  const calls: string[] = [];
  let nextId = 1000;
  const json = (data: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(data), { status });

  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const u = new URL(url);
    calls.push(`${method} ${u.pathname}${u.search}`);
    const byId = u.pathname.match(/\/releases\/(\d+)$/);
    const assetDel = u.pathname.match(/\/releases\/assets\/(\d+)$/);
    const upload = u.pathname.match(/\/releases\/(\d+)\/assets$/);

    if (u.hostname === 'uploads.github.com' && upload && method === 'POST') {
      const r = releases.find((x) => x.id === Number(upload[1]))!;
      const name = u.searchParams.get('name')!;
      if ((r.assets ?? []).some((a) => a.name === name)) return json({}, 422);
      r.assets = [...(r.assets ?? []), { id: nextId++, name }];
      return json({}, 201);
    }
    if (assetDel && method === 'DELETE') {
      for (const r of releases)
        r.assets = (r.assets ?? []).filter((a) => a.id !== Number(assetDel[1]));
      return json(null, 204);
    }
    if (byId && method === 'GET') return json(releases.find((r) => r.id === Number(byId[1])));
    if (byId && method === 'PATCH') {
      const r = releases.find((x) => x.id === Number(byId[1]))!;
      Object.assign(r, JSON.parse(String(init.body)));
      return json(r);
    }
    if (u.pathname.endsWith('/releases') && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const r: Release = { id: nextId++, tag_name: body.tag_name, draft: body.draft, assets: [] };
      releases.unshift(r);
      return json(r, 201);
    }
    if (u.pathname.endsWith('/releases') && method === 'GET') {
      const page = Number(u.searchParams.get('page') ?? 1);
      return json(releases.slice((page - 1) * 100, page * 100));
    }
    return json({ message: 'unexpected' }, 500);
  };
  const api: Api = { repo: 'o/r', token: 't', fetch };
  return { api, releases, calls };
}

const release = (id: number, tag: string, draft: boolean, names: string[] = []): Release => ({
  id,
  tag_name: tag,
  draft,
  assets: names.map((name, i) => ({ id: id * 10 + i, name })),
});

describe('ensureDraft', () => {
  it('creates a draft when the tag has no release', async () => {
    const gh = fakeGitHub([release(1, 'v1.0.0', false)]);
    const r = await ensureDraft(gh.api, 'v1.0.1');
    expect(r).toMatchObject({ tag_name: 'v1.0.1', draft: true });
    expect(gh.releases).toHaveLength(2);
  });

  it('reuses the existing release on a re-run instead of creating a second', async () => {
    const gh = fakeGitHub([release(7, 'v1.0.1', true)]);
    expect((await ensureDraft(gh.api, 'v1.0.1')).id).toBe(7);
    expect(gh.releases).toHaveLength(1);
  });

  it('finds the tag past the first page of releases', async () => {
    const many = Array.from({ length: 150 }, (_, i) => release(i + 1, `v0.0.${i}`, false));
    const gh = fakeGitHub(many);
    expect((await ensureDraft(gh.api, 'v0.0.149')).id).toBe(150);
  });

  // v0.6.37: a second release sharing the tag, where one job uploaded and
  // readers looked at the other.
  it('refuses to choose between two releases sharing a tag', async () => {
    const gh = fakeGitHub([release(1, 'v1.0.1', false), release(2, 'v1.0.1', true)]);
    await expect(ensureDraft(gh.api, 'v1.0.1')).rejects.toThrow('2 releases share the tag v1.0.1');
  });
});

describe('uploadAsset', () => {
  it('attaches a file to the draft by id', async () => {
    const gh = fakeGitHub([release(5, 'v1', true)]);
    await uploadAsset(gh.api, 5, 'a.apk', new Blob(['x']));
    expect(gh.releases[0]!.assets!.map((a) => a.name)).toEqual(['a.apk']);
  });

  it('replaces a same-named asset, so a re-run converges instead of 422-ing', async () => {
    const gh = fakeGitHub([release(5, 'v1', true, ['a.apk'])]);
    await uploadAsset(gh.api, 5, 'a.apk', new Blob(['y']));
    expect(gh.releases[0]!.assets!.map((a) => a.name)).toEqual(['a.apk']);
    expect(gh.calls.some((c) => c.startsWith('DELETE'))).toBe(true);
  });
});

describe('publish', () => {
  it('keeps the release a draft when an expected asset is missing', async () => {
    const gh = fakeGitHub([release(5, 'v1', true, ['NicotinD-1.apk'])]);
    await expect(publish(gh.api, 5, ['NicotinD-1.apk', 'latest-mac.yml'])).rejects.toThrow(
      'latest-mac.yml',
    );
    expect(gh.releases[0]!.draft).toBe(true);
  });

  it('publishes with make_latest=legacy once everything is attached', async () => {
    const gh = fakeGitHub([release(5, 'v1', true, ['NicotinD-1.apk', 'latest-mac.yml'])]);
    const r = await publish(gh.api, 5, ['NicotinD-1.apk', 'latest-mac.yml']);
    expect(r.draft).toBe(false);
    expect((gh.releases[0] as Release & { make_latest?: string }).make_latest).toBe('legacy');
  });

  it('leaves an already-published release alone', async () => {
    const gh = fakeGitHub([release(5, 'v1', false, ['a'])]);
    await publish(gh.api, 5, ['a']);
    expect(gh.calls.filter((c) => c.startsWith('PATCH'))).toEqual([]);
  });
});
