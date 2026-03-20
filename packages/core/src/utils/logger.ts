import { createRequire } from 'node:module';
import pino from 'pino';

const require = createRequire(import.meta.url);
const prettyTarget = require.resolve('pino-pretty');

export function createLogger(name: string, level = 'info') {
  return pino({
    name,
    level,
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: prettyTarget, options: { colorize: true } }
        : undefined,
  });
}

export type Logger = pino.Logger;
