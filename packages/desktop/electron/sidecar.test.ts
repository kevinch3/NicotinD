import { describe, expect, it } from 'bun:test';
import { parseListeningPort } from './sidecar.js';

describe('parseListeningPort', () => {
  it('parses the handshake line', () => {
    expect(parseListeningPort('NICOTIND_LISTENING 51873')).toBe(51873);
  });

  it('ignores unrelated log lines', () => {
    expect(parseListeningPort('info: something else')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parseListeningPort('')).toBeNull();
  });

  it('tolerates trailing whitespace', () => {
    expect(parseListeningPort('NICOTIND_LISTENING 8080 \n')).toBe(8080);
  });

  it('rejects a line with trailing non-numeric text', () => {
    expect(parseListeningPort('NICOTIND_LISTENING 8080 extra')).toBeNull();
  });

  it('rejects a non-positive port', () => {
    expect(parseListeningPort('NICOTIND_LISTENING 0')).toBeNull();
  });
});
