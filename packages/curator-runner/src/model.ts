import type { FetchFn } from './mcp-client.js';

/**
 * The model's whole job: one constrained answer per cluster. It never picks a
 * tool, a song or an argument — code does — so the answer it can get wrong is
 * bounded to "which genre from this list", and the server re-checks even that.
 */
export interface Verdict {
  /** A vocabulary genre, or `unknown`. */
  genre: string;
  confidence: 'high' | 'low';
  evidence: string;
}

export interface ClassifyPrompt {
  system: string;
  user: string;
  vocabulary: readonly string[];
}

export interface GenreModel {
  classify(prompt: ClassifyPrompt): Promise<Verdict>;
}

export const UNKNOWN = 'unknown';
const MODEL_TIMEOUT_MS = 180_000;
const EVIDENCE_MAX = 300;

/**
 * JSON schema for a verdict. The genre is an enum of the vocabulary, so a
 * server with grammar-constrained decoding (Ollama, llama.cpp, vLLM) cannot
 * emit an invented genre at all.
 */
export function verdictSchema(vocabulary: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      genre: { type: 'string', enum: [...vocabulary, UNKNOWN] },
      confidence: { type: 'string', enum: ['high', 'low'] },
      evidence: { type: 'string' },
    },
    required: ['genre', 'confidence', 'evidence'],
    additionalProperties: false,
  };
}

/**
 * Turn whatever came back into a verdict, treating anything off-schema as
 * `unknown`. Not every endpoint enforces the schema, and a small model's
 * near-miss ("tech house", a trailing period) is matched case-insensitively
 * to the vocabulary spelling rather than trusted verbatim.
 */
export function parseVerdict(raw: unknown, vocabulary: readonly string[]): Verdict {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const wanted = typeof o.genre === 'string' ? o.genre.trim().replace(/\.$/, '').toLowerCase() : '';
  const genre = vocabulary.find((g) => g.toLowerCase() === wanted) ?? UNKNOWN;
  const confidence = o.confidence === 'high' && genre !== UNKNOWN ? 'high' : 'low';
  const evidence = typeof o.evidence === 'string' ? o.evidence.slice(0, EVIDENCE_MAX) : '';
  return { genre, confidence, evidence };
}

export class ModelError extends Error {}

/**
 * Any OpenAI-compatible chat-completions endpoint: Ollama, llama.cpp server,
 * vLLM, LM Studio, GitHub Models, OpenRouter, Groq. Asks for a strict JSON
 * schema first and falls back to plain JSON mode for servers that reject it.
 */
export function openAiCompatModel(opts: {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  temperature: number;
  fetchFn?: FetchFn;
}): GenreModel {
  const fetchFn = opts.fetchFn ?? fetch;
  let schemaSupported = true;
  const post = (body: Record<string, unknown>) =>
    fetchFn(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  return {
    async classify(prompt) {
      const base = {
        model: opts.model,
        temperature: opts.temperature,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      };
      let res: Response | null = null;
      if (schemaSupported) {
        res = await post({
          ...base,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'genre_verdict',
              strict: true,
              schema: verdictSchema(prompt.vocabulary),
            },
          },
        });
        if (res.status === 400 || res.status === 422) schemaSupported = false;
      }
      if (!schemaSupported) {
        res = await post({ ...base, response_format: { type: 'json_object' } });
      }
      if (!res || !res.ok) throw new ModelError(`model HTTP ${res?.status ?? 'no response'}`);
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return parseVerdict(body.choices?.[0]?.message?.content ?? '', prompt.vocabulary);
    },
  };
}

/** The Anthropic Messages API, with the verdict as a forced tool call. */
export function anthropicModel(opts: {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  fetchFn?: FetchFn;
}): GenreModel {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    async classify(prompt) {
      const res = await fetchFn(`${opts.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 512,
          temperature: opts.temperature,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          tools: [
            {
              name: 'record_verdict',
              description: 'Record the genre verdict for this group of songs.',
              input_schema: verdictSchema(prompt.vocabulary),
            },
          ],
          tool_choice: { type: 'tool', name: 'record_verdict' },
        }),
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      });
      if (!res.ok) throw new ModelError(`model HTTP ${res.status}`);
      const body = (await res.json()) as {
        content?: Array<{ type?: string; input?: unknown }>;
      };
      const call = body.content?.find((c) => c.type === 'tool_use');
      return parseVerdict(call?.input ?? null, prompt.vocabulary);
    },
  };
}
