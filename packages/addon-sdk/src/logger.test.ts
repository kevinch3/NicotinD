import { describe, it, expect } from 'bun:test';
import { logFormat } from './logger.js';

describe('logFormat', () => {
  it('is pretty for a local run', () => {
    expect(logFormat({})).toBe('pretty');
  });

  it('is JSON under NODE_ENV=production', () => {
    expect(logFormat({ NODE_ENV: 'production' })).toBe('json');
  });

  it('LOG_FORMAT overrides NODE_ENV either way', () => {
    expect(logFormat({ LOG_FORMAT: 'json' })).toBe('json');
    expect(logFormat({ LOG_FORMAT: 'pretty', NODE_ENV: 'production' })).toBe('pretty');
  });

  it('ignores an unknown LOG_FORMAT', () => {
    expect(logFormat({ LOG_FORMAT: 'yaml', NODE_ENV: 'production' })).toBe('json');
    expect(logFormat({ LOG_FORMAT: 'yaml' })).toBe('pretty');
  });
});
