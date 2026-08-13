import { describe, expect, it } from 'bun:test';
import { CAPABILITY_RISK, capabilityRiskLine } from './addon-capability-risk.js';

describe('capability risk catalog', () => {
  it('every entry is a non-empty plain-language line', () => {
    for (const [cap, line] of Object.entries(CAPABILITY_RISK)) {
      expect(line.length, `${cap} risk line`).toBeGreaterThan(10);
      expect(line.trim()).toBe(line);
    }
  });

  it('names the ingest risk for download (the gap coarse permissions hide)', () => {
    expect(CAPABILITY_RISK.download.toLowerCase()).toContain('librar');
  });

  it('resolves a known capability to its catalog line', () => {
    expect(capabilityRiskLine('download')).toBe(CAPABILITY_RISK.download);
    expect(capabilityRiskLine('lyrics')).toBe(CAPABILITY_RISK.lyrics);
  });

  it('falls back to a generic line for an unrecognized capability string', () => {
    const line = capabilityRiskLine('some-future-capability');
    expect(line.length).toBeGreaterThan(10);
    expect(line).not.toBe(CAPABILITY_RISK.download);
  });
});
