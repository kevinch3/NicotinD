import { describe, it, expect, mock } from 'bun:test';
import { parse, stringify } from 'yaml';
import type { Slskd } from '@nicotind/slskd-client';
import { updateExternalSoulseekCredentials } from './slskd-config.js';

// The function takes the Slskd client as an injected param, so a hand-rolled
// fake (no module mocking) fully exercises the read → rewrite → reconnect flow.
function fakeSlskd(initialYaml: string) {
  let yaml = initialYaml;
  const getYaml = mock(async () => yaml);
  const updateYaml = mock(async (next: string) => {
    yaml = next;
  });
  const connect = mock(async () => undefined);
  const slskd = {
    options: { getYaml, updateYaml },
    server: { connect },
  } as unknown as Slskd;
  return { slskd, getYaml, updateYaml, connect, read: () => yaml };
}

describe('updateExternalSoulseekCredentials', () => {
  it('sets username/password into the soulseek block and reconnects', async () => {
    const { slskd, updateYaml, connect, read } = fakeSlskd('soulseek:\n  username: old\n');
    await updateExternalSoulseekCredentials(slskd, 'new-user', 'new-pass');

    expect(updateYaml).toHaveBeenCalledTimes(1);
    const written = parse(read()) as { soulseek: { username: string; password: string } };
    expect(written.soulseek.username).toBe('new-user');
    expect(written.soulseek.password).toBe('new-pass');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('preserves other soulseek keys while overwriting credentials', async () => {
    const { slskd, read } = fakeSlskd(stringify({ soulseek: { listening_port: 50000, username: 'old' } }));
    await updateExternalSoulseekCredentials(slskd, 'u', 'p');

    const written = parse(read()) as { soulseek: Record<string, unknown> };
    expect(written.soulseek.listening_port).toBe(50000);
    expect(written.soulseek.username).toBe('u');
    expect(written.soulseek.password).toBe('p');
  });

  it('handles an empty / missing config by creating the soulseek block', async () => {
    const { slskd, read } = fakeSlskd('');
    await updateExternalSoulseekCredentials(slskd, 'u', 'p');

    const written = parse(read()) as { soulseek: { username: string; password: string } };
    expect(written.soulseek).toEqual({ username: 'u', password: 'p' });
  });
});
