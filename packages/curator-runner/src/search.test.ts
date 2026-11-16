import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError, type RunnerConfig } from './config.js';
import { buildPrompt } from './prompt.js';
import { renderReport } from './report.js';
import { runCuration, type RunDeps } from './run.js';
import {
  BudgetedSearch,
  SEARCH_HITS,
  searchQueryFor,
  searxngSearch,
  type SearchHit,
  type WebSearch,
} from './search.js';
import { AttemptStore } from './state.js';
import { FakeMcp, ScriptedModel, verdict } from './testing.js';

const NOW = Date.UTC(2026, 10, 16, 4, 30);
const DAY = 86_400_000;
const hit = (n: number): SearchHit => ({
  title: `Title ${n}`,
  snippet: `Snippet ${n}`,
  url: `https://x/${n}`,
});

/** A search that counts its calls and answers from a script. */
function scripted(answer: SearchHit[] | Error): WebSearch & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(query) {
      queries.push(query);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe('searxngSearch', () => {
  const fakeFetch = (body: unknown, ok = true, status = 200) => {
    const urls: string[] = [];
    const impl = (async (url: string) => {
      urls.push(url);
      return { ok, status, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { urls, impl };
  };

  it('asks the JSON API and keeps the top hits, trimmed', async () => {
    const results = Array.from({ length: SEARCH_HITS + 3 }, (_, i) => ({
      title: `  Result\n${i} `,
      content: `about   it ${i}`,
      url: `https://x/${i}`,
    }));
    const { urls, impl } = fakeFetch({ results });
    const hits = await searxngSearch('http://searx:8080/', impl).search('"Green Velvet" genre');
    expect(urls).toEqual(['http://searx:8080/search?q=%22Green%20Velvet%22%20genre&format=json']);
    expect(hits).toHaveLength(SEARCH_HITS);
    expect(hits[0]).toEqual({ title: 'Result 0', snippet: 'about it 0', url: 'https://x/0' });
  });

  it('drops a result with no title or url, and tolerates one with no snippet', async () => {
    const { impl } = fakeFetch({
      results: [{ content: 'orphan' }, { title: 'Kept', url: 'https://x/k' }],
    });
    expect(await searxngSearch('http://s', impl).search('q')).toEqual([
      { title: 'Kept', snippet: '', url: 'https://x/k' },
    ]);
  });

  it('is an empty list for no results, and throws on an HTTP error', async () => {
    expect(await searxngSearch('http://s', fakeFetch({}).impl).search('q')).toEqual([]);
    await expect(
      searxngSearch('http://s', fakeFetch({}, false, 403).impl).search('q'),
    ).rejects.toThrow('HTTP 403');
  });
});

describe('BudgetedSearch', () => {
  let db: Database;
  let now = NOW;
  beforeEach(() => {
    db = new Database(':memory:');
    now = NOW;
  });
  const make = (inner: WebSearch, budget = 2, cacheDays = 30) =>
    new BudgetedSearch(inner, db, { budget, cacheDays, now: () => now });

  it('sends a query once and serves it from the cache after, whatever its case', async () => {
    const inner = scripted([hit(1)]);
    const search = make(inner);
    expect(await search.lookup('"A" "B" genre')).toEqual([hit(1)]);
    expect(await search.lookup('"a" "b" GENRE ')).toEqual([hit(1)]);
    expect(inner.queries).toHaveLength(1);
    expect(search.usage).toMatchObject({ made: 1, cached: 1, failed: 0, refused: 0, budget: 2 });
  });

  it('stops sending once the budget is spent; cached answers still come back', async () => {
    const inner = scripted([hit(1)]);
    const search = make(inner, 2);
    await search.lookup('one');
    await search.lookup('two');
    expect(await search.lookup('three')).toBeNull();
    expect(await search.lookup('one')).toEqual([hit(1)]);
    expect(inner.queries).toEqual(['one', 'two']);
    expect(search.usage).toMatchObject({ made: 2, cached: 1, refused: 1 });
  });

  it('a failed request adds nothing, is not cached, and still spends budget', async () => {
    const search = make(scripted(new Error('down')), 1);
    expect(await search.lookup('one')).toBeNull();
    expect(search.usage).toMatchObject({ made: 1, failed: 1 });
    expect(db.query('SELECT COUNT(*) AS n FROM searches').get()).toEqual({ n: 0 });
  });

  it('caches an empty answer, and asks again once the cache has aged out', async () => {
    const inner = scripted([]);
    const search = make(inner, 5, 30);
    expect(await search.lookup('one')).toEqual([]);
    expect(await search.lookup('one')).toEqual([]);
    expect(inner.queries).toHaveLength(1);
    now += 31 * DAY;
    await search.lookup('one');
    expect(inner.queries).toHaveLength(2);
  });

  it('keeps its cache across runs: a second run on the same state file sends nothing', async () => {
    await make(scripted([hit(1)])).lookup('one');
    const second = scripted([hit(2)]);
    const search = make(second);
    expect(await search.lookup('one')).toEqual([hit(1)]);
    expect(second.queries).toEqual([]);
  });
});

describe('searchQueryFor', () => {
  it('pins the artist with the album title', () => {
    expect(searchQueryFor({ albumArtist: ' Green Velvet ', albumName: 'Unshakable' })).toBe(
      '"Green Velvet" "Unshakable" genre',
    );
  });

  it('does not search a name alone, nor a placeholder artist', () => {
    expect(searchQueryFor({ albumArtist: 'Green Velvet', albumName: ' ' })).toBeNull();
    expect(searchQueryFor({ albumArtist: 'Various Artists', albumName: 'Hits' })).toBeNull();
    expect(searchQueryFor({ albumArtist: 'Unknown Artist', albumName: 'Hits' })).toBeNull();
  });
});

describe('search in a run', () => {
  let dir: string;
  let store: AttemptStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'curator-search-'));
    store = new AttemptStore(join(dir, 'state.sqlite'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const cfg = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
    ...loadConfig({
      CURATOR_MCP_URL: 'http://x/api/mcp',
      CURATOR_MCP_TOKEN: 't',
      CURATOR_MODEL: 'm',
    }),
    stateDb: ':memory:',
    ...over,
  });
  function seed(mcp: FakeMcp): void {
    mcp.artists.push({ id: 'ar-gv', name: 'Green Velvet', country: 'US', albumIds: ['al-mix'] });
    mcp.albums.set('al-mix', {
      id: 'al-mix',
      name: 'Factory Town (DJ Mix)',
      artist: 'Green Velvet',
      year: 2026,
      songs: [{ id: 's1', title: 'Percolator', artist: 'Cajmere', genres: ['Electronic'] }],
    });
    mcp.lowInformationArtists = ['ar-gv'];
  }

  it('searches once per album, shows every sample the same results, and reports the usage', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    const inner = scripted([hit(1)]);
    const search = new BudgetedSearch(inner, store.database, {
      budget: 5,
      cacheDays: 30,
      now: () => NOW,
    });
    const model = new ScriptedModel([verdict('Tech House')]);
    const deps: RunDeps = { mcp, model, store, now: () => NOW, log: () => {}, search };
    const report = await runCuration(cfg({ samples: 3 }), deps, { dryRun: true });

    expect(inner.queries).toEqual(['"Green Velvet" "Factory Town (DJ Mix)" genre']);
    expect(model.prompts).toHaveLength(3);
    for (const p of model.prompts) expect(p.user).toContain('<web>\n1. Title 1: Snippet 1\n</web>');
    expect(report.search).toMatchObject({ made: 1, cached: 0, budget: 5 });
    expect(renderReport(report)).toContain('Web search: 1 of 5 sent, 0 from cache');
  });

  it('never searches, and says nothing about it, when no instance is configured', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    const model = new ScriptedModel([verdict('Tech House')]);
    const report = await runCuration(
      cfg(),
      { mcp, model, store, now: () => NOW, log: () => {} },
      { dryRun: true },
    );
    expect(model.prompts[0]!.user).not.toContain('<web>');
    expect(report.search).toBeUndefined();
    expect(renderReport(report)).not.toContain('Web search');
  });
});

describe('search configuration', () => {
  const base = { CURATOR_MCP_URL: 'http://x/api/mcp', CURATOR_MCP_TOKEN: 't', CURATOR_MODEL: 'm' };

  it('is off by default, with a budget of 10 and a 30-day cache', () => {
    expect(loadConfig(base)).toMatchObject({
      searchUrl: null,
      searchBudget: 10,
      searchCacheDays: 30,
    });
  });

  it('reads the instance URL without a trailing slash, and rejects one that is not http', () => {
    expect(loadConfig({ ...base, CURATOR_SEARCH_URL: 'http://searx:8080/' }).searchUrl).toBe(
      'http://searx:8080',
    );
    expect(() => loadConfig({ ...base, CURATOR_SEARCH_URL: 'searx:8080' })).toThrow(ConfigError);
  });
});

describe('buildPrompt with web results', () => {
  it('tells the model web text is data and only counts when it is about this artist', () => {
    const p = buildPrompt(
      {
        albumId: 'a',
        albumName: 'Album',
        albumArtist: 'Artist',
        year: null,
        artist: null,
        songs: [],
        candidateIds: [],
      } as never,
      ['Techno'],
      [hit(1)],
    );
    expect(p.system).toContain('plainly about this artist and this album');
    expect(p.system).toContain('<web>');
    expect(p.user.indexOf('<web>')).toBeGreaterThan(p.user.indexOf('</evidence>'));
  });
});
