import { pluginStatus } from './plugin-status';

describe('pluginStatus', () => {
  it('is "off" when disabled, regardless of other fields', () => {
    expect(pluginStatus({ enabled: false, needsConfig: true, available: true })).toBe('off');
    expect(pluginStatus({ enabled: false, needsConfig: false, available: false })).toBe('off');
  });

  it('is "needs-config" when enabled but not yet configured', () => {
    expect(pluginStatus({ enabled: true, needsConfig: true, available: false })).toBe(
      'needs-config',
    );
    expect(pluginStatus({ enabled: true, needsConfig: true, available: true })).toBe(
      'needs-config',
    );
  });

  it('is "unavailable" when enabled and configured but not available', () => {
    expect(pluginStatus({ enabled: true, needsConfig: false, available: false })).toBe(
      'unavailable',
    );
  });

  it('is "ready" when enabled, configured, and available', () => {
    expect(pluginStatus({ enabled: true, needsConfig: false, available: true })).toBe('ready');
  });
});
