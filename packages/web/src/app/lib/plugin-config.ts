import type { PluginConfigField } from '../services/plugin.service';

/**
 * Build the config payload to PUT for a plugin's edit form. Pure (no DI), so it's
 * unit-testable under the web JIT vitest limitation. Rules:
 *  - `text` fields are always sent (an empty string is a valid clear).
 *  - `password` fields are **write-only**: a blank input means "keep the current
 *    value" and is omitted, so the server-side merge preserves the stored secret.
 *    A non-blank input overwrites it.
 */
export function buildPluginConfigPayload(
  fields: PluginConfigField[],
  values: Record<string, string>,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key] ?? '';
    if (field.type === 'password' && value === '') continue;
    payload[field.key] = value;
  }
  return payload;
}

/**
 * Seed the form's editable values from a plugin's `config` (non-secret prefill).
 * Password fields always start blank (their stored value is never returned).
 */
export function initialPluginConfigValues(
  fields: PluginConfigField[],
  config: Record<string, unknown> | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const raw = config?.[field.key];
    values[field.key] = field.type === 'password' || raw == null ? '' : String(raw);
  }
  return values;
}
