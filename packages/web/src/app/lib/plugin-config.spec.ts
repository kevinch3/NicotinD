import { describe, it, expect } from 'vitest';
import { buildPluginConfigPayload, initialPluginConfigValues } from './plugin-config';
import type { PluginConfigField } from '../services/plugin.service';

const FIELDS: PluginConfigField[] = [
  { key: 'clientId', label: 'Client ID', type: 'text' },
  { key: 'clientSecret', label: 'Client Secret', type: 'password' },
];

describe('buildPluginConfigPayload', () => {
  it('sends text fields and a non-blank password', () => {
    expect(buildPluginConfigPayload(FIELDS, { clientId: 'id', clientSecret: 'secret' })).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
    });
  });

  it('omits a blank password (so the server-side merge keeps the stored secret)', () => {
    expect(buildPluginConfigPayload(FIELDS, { clientId: 'id', clientSecret: '' })).toEqual({
      clientId: 'id',
    });
  });

  it('still sends an empty text field (a valid clear)', () => {
    expect(buildPluginConfigPayload(FIELDS, { clientId: '', clientSecret: '' })).toEqual({
      clientId: '',
    });
  });

  it('treats a missing value as blank', () => {
    expect(buildPluginConfigPayload(FIELDS, {})).toEqual({ clientId: '' });
  });
});

describe('initialPluginConfigValues', () => {
  it('prefills text fields from config and starts password fields blank', () => {
    expect(initialPluginConfigValues(FIELDS, { clientId: 'stored-id', clientSecret: 'leaked' })).toEqual({
      clientId: 'stored-id',
      clientSecret: '',
    });
  });

  it('defaults to empty strings when config is undefined', () => {
    expect(initialPluginConfigValues(FIELDS, undefined)).toEqual({ clientId: '', clientSecret: '' });
  });
});
