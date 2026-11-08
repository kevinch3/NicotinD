import { createRequire } from 'node:module';
import pino from 'pino';

const require = createRequire(import.meta.url);
const prettyTarget = require.resolve('pino-pretty');

export type LogFormat = 'json' | 'pretty';

/**
 * `LOG_FORMAT` wins; otherwise `NODE_ENV=production` means JSON. The images set
 * `LOG_FORMAT=json` so `docker logs | jq` works (#1626); a local run stays pretty.
 */
export function logFormat(env: Record<string, string | undefined> = process.env): LogFormat {
  if (env.LOG_FORMAT === 'json' || env.LOG_FORMAT === 'pretty') return env.LOG_FORMAT;
  return env.NODE_ENV === 'production' ? 'json' : 'pretty';
}

export function createLogger(name: string, level = 'info') {
  return pino({
    name,
    level,
    transport:
      logFormat() === 'pretty' ? { target: prettyTarget, options: { colorize: true } } : undefined,
  });
}

export type Logger = pino.Logger;
