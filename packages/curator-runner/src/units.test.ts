import { describe, it, expect } from 'bun:test';
import { isReplaceable, loadCluster } from './clusters.js';
import { ConfigError, loadConfig } from './config.js';
import { decide } from './decide.js';
import { McpClient, McpError } from './mcp-client.js';
import { renderReport } from './report.js';
import type { RunReport } from './run.js';
import { FakeMcp, verdict } from './testing.js';

describe('loadConfig', () => {
  const base = {
    CURATOR_MCP_URL: 'http://nicotind:8484/api/mcp',
    CURATOR_MCP_TOKEN: 'nca_x',
    CURATOR_MODEL: 'qwen2.5:7b-instruct',
  };

  it('defaults to a self-hosted Ollama endpoint, propose mode and 3 samples', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      provider: 'openai',
      modelBaseUrl: 'http://localhost:11434/v1',
      apply: 'propose',
      samples: 3,
      cardLanguage: 'en',
    });
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({
        CURATOR_APPLY: 'yolo',
        CURATOR_SAMPLES: '0',
        CURATOR_MODEL_PROVIDER: 'anthropic',
      });
      throw new Error('expected ConfigError');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const problems = (e as ConfigError).problems.join('\n');
      for (const k of [
        'CURATOR_MCP_URL',
        'CURATOR_MCP_TOKEN',
        'CURATOR_MODEL',
        'CURATOR_APPLY',
        'CURATOR_SAMPLES',
        'CURATOR_MODEL_API_KEY',
      ]) {
        expect(problems).toContain(k);
      }
    }
  });

  it('strips a trailing slash from the base URL and reads targets', () => {
    const c = loadConfig({
      ...base,
      CURATOR_MODEL_BASE_URL: 'https://models.github.ai/inference/',
      CURATOR_TARGET_LOW_INFORMATION: '50',
    });
    expect(c.modelBaseUrl).toBe('https://models.github.ai/inference');
    expect(c.targets).toEqual({ lowInformation: 50, missing: null });
  });
});

describe('decide', () => {
  it('skips when half or more of the samples are unknown', () => {
    expect(decide([verdict('unknown', 'low'), verdict('Techno')], 'auto').kind).toBe('skip');
  });
  it('applies only a unanimous, all-high verdict, and only in auto mode', () => {
    const v = [verdict('Techno'), verdict('Techno'), verdict('Techno')];
    expect(decide(v, 'auto')).toMatchObject({ kind: 'apply', genre: 'Techno' });
    expect(decide(v, 'propose').kind).toBe('propose');
  });
  it('proposes the candidates by votes, at most three', () => {
    const d = decide(
      [verdict('A'), verdict('B'), verdict('B'), verdict('C'), verdict('D')],
      'auto',
    );
    expect(d.kind === 'propose' && d.candidates.map((c) => c.genre)).toEqual(['B', 'A', 'C']);
  });
});

describe('isReplaceable / loadCluster', () => {
  it('mirrors the server rule: empty, junk-only, or one catch-all', () => {
    expect(isReplaceable([])).toBe(true);
    expect(isReplaceable(['Music'])).toBe(true);
    expect(isReplaceable(['Electronic'])).toBe(true);
    expect(isReplaceable(['Electronic', 'Techno'])).toBe(false);
    expect(isReplaceable(['Rock'])).toBe(false);
  });

  it('on a server without full genre lists, only a genre-less song is a candidate', async () => {
    const mcp = new FakeMcp();
    mcp.albums.set('al', {
      id: 'al',
      name: 'A',
      artist: 'X',
      year: null,
      songs: [
        { id: 'empty', title: 't', artist: 'X', genres: [] },
        { id: 'elec', title: 't', artist: 'X', genres: ['Electronic'] },
      ],
    });
    const original = mcp.call.bind(mcp);
    mcp.call = async (name, args) => {
      const res = await original(name, args);
      if (name !== 'get_album_tracks') return res;
      const body = JSON.parse(res.text) as { songs: Array<Record<string, unknown>> };
      for (const s of body.songs) delete s.genres;
      return { ok: true, text: JSON.stringify(body) };
    };
    const cluster = await loadCluster(mcp, 'al', new Map());
    expect(cluster?.candidateIds).toEqual(['empty']);
  });
});

describe('McpClient', () => {
  it('sends the bearer token with a timeout and unwraps a tool result', async () => {
    let seen: RequestInit | null = null;
    const client = new McpClient('http://x/api/mcp', 'nca_t', async (_url, init) => {
      seen = init;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: '{"a":1}' }] } }),
      );
    });
    expect(await client.call('search_library', { query: 'x' })).toEqual({
      ok: true,
      text: '{"a":1}',
    });
    expect(new Headers(seen!.headers).get('Authorization')).toBe('Bearer nca_t');
    expect(seen!.signal).toBeDefined();
  });

  it('names a rejected token', async () => {
    const client = new McpClient(
      'http://x',
      'nca_t',
      async () => new Response('{}', { status: 401 }),
    );
    await expect(client.initialize()).rejects.toBeInstanceOf(McpError);
  });
});

describe('renderReport', () => {
  it('renders the before/after table and one row per album', () => {
    const report: RunReport = {
      startedAt: Date.UTC(2026, 9, 18, 4, 30),
      finishedAt: Date.UTC(2026, 9, 18, 4, 36),
      model: 'openai:qwen',
      apply: 'auto',
      dryRun: false,
      before: { lowInformation: 134, missing: 100 },
      after: { lowInformation: 132, missing: 100 },
      iterations: 1,
      stop: 'worklist-exhausted',
      outcomes: [
        {
          albumId: 'al',
          album: 'Mix | Vol 1',
          albumArtist: 'Green Velvet',
          candidates: 2,
          result: 'applied',
          decision: { kind: 'apply', genre: 'Tech House', candidates: [] },
          written: 2,
          verified: 2,
        },
      ],
    };
    const md = renderReport(report);
    expect(md).toContain('# Curator run — 2026-10-18 04:30 UTC');
    expect(md).toContain('| genres.lowInformation | 134 | 132 | −2 |');
    expect(md).toContain('Mix \\| Vol 1');
    expect(md).toContain('Tech House: 2 written, 2 read back');
  });
});
