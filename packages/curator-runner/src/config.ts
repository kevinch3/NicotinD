/**
 * Runner configuration, from the environment only — the runner is a one-shot
 * process a scheduler starts, so there is no config file to drift from the
 * cron line or the compose service that sets these. → docs/curator-runner.md
 */

export type Provider = 'openai' | 'anthropic';
export type ApplyMode = 'propose' | 'auto';
export type CardLanguage = 'en' | 'es';

export interface RunnerConfig {
  mcpUrl: string;
  mcpToken: string;
  provider: Provider;
  modelBaseUrl: string;
  model: string;
  modelApiKey: string | null;
  /** `propose` files cards a human taps; `auto` writes unanimous high-confidence verdicts. */
  apply: ApplyMode;
  /** Verdicts asked per cluster; a write needs all of them to agree. */
  samples: number;
  temperature: number;
  maxClusters: number;
  maxMinutes: number;
  targets: { lowInformation: number | null; missing: number | null };
  stateDb: string;
  cooldownDays: number;
  cardLanguage: CardLanguage;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid curator-runner configuration:\n- ${problems.join('\n- ')}`);
  }
}

/** Ollama's OpenAI-compatible endpoint: the self-hosted default. */
const DEFAULT_BASE_URL: Record<Provider, string> = {
  openai: 'http://localhost:11434/v1',
  anthropic: 'https://api.anthropic.com',
};

export function loadConfig(env: Record<string, string | undefined>): RunnerConfig {
  const problems: string[] = [];
  const get = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : null;
  };
  const required = (k: string) => {
    const v = get(k);
    if (!v) problems.push(`${k} is required`);
    return v ?? '';
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[], dflt: T): T => {
    const v = get(k) ?? dflt;
    if (!(allowed as readonly string[]).includes(v)) {
      problems.push(`${k} must be one of ${allowed.join(', ')} (got "${v}")`);
      return dflt;
    }
    return v as T;
  };
  const num = (k: string, dflt: number, min: number, max: number) => {
    const raw = get(k);
    if (raw == null) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      problems.push(`${k} must be a number from ${min} to ${max} (got "${raw}")`);
      return dflt;
    }
    return n;
  };
  const optionalCount = (k: string) => {
    const raw = get(k);
    if (raw == null) return null;
    return num(k, 0, 0, 1_000_000);
  };

  const provider = oneOf<Provider>('CURATOR_MODEL_PROVIDER', ['openai', 'anthropic'], 'openai');
  const config: RunnerConfig = {
    mcpUrl: required('CURATOR_MCP_URL'),
    mcpToken: required('CURATOR_MCP_TOKEN'),
    provider,
    modelBaseUrl: (get('CURATOR_MODEL_BASE_URL') ?? DEFAULT_BASE_URL[provider]).replace(/\/+$/, ''),
    model: required('CURATOR_MODEL'),
    modelApiKey: get('CURATOR_MODEL_API_KEY'),
    apply: oneOf<ApplyMode>('CURATOR_APPLY', ['propose', 'auto'], 'propose'),
    samples: Math.round(num('CURATOR_SAMPLES', 3, 1, 9)),
    temperature: num('CURATOR_TEMPERATURE', 0.4, 0, 2),
    maxClusters: Math.round(num('CURATOR_MAX_CLUSTERS', 20, 1, 1000)),
    maxMinutes: num('CURATOR_MAX_MINUTES', 30, 1, 24 * 60),
    targets: {
      lowInformation: optionalCount('CURATOR_TARGET_LOW_INFORMATION'),
      missing: optionalCount('CURATOR_TARGET_MISSING'),
    },
    stateDb: get('CURATOR_STATE_DB') ?? 'curator-state.sqlite',
    cooldownDays: num('CURATOR_COOLDOWN_DAYS', 30, 0, 3650),
    cardLanguage: oneOf<CardLanguage>('CURATOR_CARD_LANGUAGE', ['en', 'es'], 'en'),
  };
  if (provider === 'anthropic' && !config.modelApiKey) {
    problems.push('CURATOR_MODEL_API_KEY is required for the anthropic provider');
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
