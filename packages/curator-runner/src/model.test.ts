import { describe, it, expect } from 'bun:test';
import { anthropicModel, openAiCompatModel, parseVerdict, verdictSchema } from './model.js';

const VOCAB = ['Tech House', 'Techno'];
const prompt = { system: 'sys', user: 'usr', vocabulary: VOCAB };

describe('parseVerdict', () => {
  it.each<[unknown, string, 'high' | 'low']>([
    [{ genre: 'Tech House', confidence: 'high', evidence: 'e' }, 'Tech House', 'high'],
    [JSON.stringify({ genre: 'techno.', confidence: 'high', evidence: 'e' }), 'Techno', 'high'],
    // Off-vocabulary, catch-all or garbage → unknown, never trusted verbatim.
    [{ genre: 'Psybient', confidence: 'high', evidence: 'e' }, 'unknown', 'low'],
    [{ genre: 'Electronic', confidence: 'high' }, 'unknown', 'low'],
    ['not json at all', 'unknown', 'low'],
    [null, 'unknown', 'low'],
    [{ genre: 'Techno', confidence: 'certain' }, 'Techno', 'low'],
  ])('%j → %s/%s', (raw, genre, confidence) => {
    const v = parseVerdict(raw, VOCAB);
    expect(v.genre).toBe(genre);
    expect(v.confidence).toBe(confidence);
  });

  it('constrains the genre to the vocabulary plus unknown', () => {
    const schema = verdictSchema(VOCAB) as {
      properties: { genre: { enum: string[] } };
    };
    expect(schema.properties.genre.enum).toEqual(['Tech House', 'Techno', 'unknown']);
  });
});

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    requests.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: new Headers(init.headers),
    });
    expect(init.signal).toBeDefined();
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return { fetchFn, requests };
}

describe('openAiCompatModel', () => {
  it('asks for a strict JSON schema and parses the message content', async () => {
    const { fetchFn, requests } = fakeFetch([
      {
        status: 200,
        body: {
          choices: [
            { message: { content: '{"genre":"Techno","confidence":"high","evidence":"e"}' } },
          ],
        },
      },
    ]);
    const model = openAiCompatModel({
      baseUrl: 'http://ollama/v1',
      model: 'qwen',
      apiKey: null,
      temperature: 0.4,
      fetchFn,
    });
    expect((await model.classify(prompt)).genre).toBe('Techno');
    expect(requests[0]!.url).toBe('http://ollama/v1/chat/completions');
    expect(requests[0]!.body.response_format).toMatchObject({ type: 'json_schema' });
    expect(requests[0]!.headers.get('Authorization')).toBeNull();
  });

  it('falls back to JSON mode once when the server rejects json_schema, and stays there', async () => {
    const ok = {
      status: 200,
      body: { choices: [{ message: { content: '{"genre":"Techno","confidence":"low"}' } }] },
    };
    const { fetchFn, requests } = fakeFetch([{ status: 400, body: {} }, ok, ok]);
    const model = openAiCompatModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      apiKey: 'k',
      temperature: 0,
      fetchFn,
    });
    await model.classify(prompt);
    await model.classify(prompt);
    expect(requests.map((r) => (r.body.response_format as { type: string }).type)).toEqual([
      'json_schema',
      'json_object',
      'json_object',
    ]);
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer k');
  });

  it('throws on a server error, so the run can count it', async () => {
    const { fetchFn } = fakeFetch([{ status: 503, body: {} }]);
    const model = openAiCompatModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      apiKey: null,
      temperature: 0,
      fetchFn,
    });
    await expect(model.classify(prompt)).rejects.toThrow('503');
  });
});

describe('anthropicModel', () => {
  it('forces the verdict tool and reads its input', async () => {
    const { fetchFn, requests } = fakeFetch([
      {
        status: 200,
        body: {
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', input: { genre: 'Tech House', confidence: 'high', evidence: 'e' } },
          ],
        },
      },
    ]);
    const model = anthropicModel({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-haiku-5-5',
      apiKey: 'sk',
      temperature: 0.4,
      fetchFn,
    });
    expect((await model.classify(prompt)).genre).toBe('Tech House');
    expect(requests[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(requests[0]!.body.tool_choice).toEqual({ type: 'tool', name: 'record_verdict' });
    expect(requests[0]!.headers.get('x-api-key')).toBe('sk');
  });
});
