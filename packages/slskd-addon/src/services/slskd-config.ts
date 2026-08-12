import { parse, stringify } from 'yaml';
import type { Slskd } from '@nicotind/slskd-client';

type YamlConfig = Record<string, unknown> & {
  soulseek?: Record<string, unknown>;
};

export async function updateExternalSoulseekCredentials(
  slskd: Slskd,
  username: string,
  password: string,
): Promise<void> {
  const raw = await slskd.options.getYaml();
  const config = (parse(raw) ?? {}) as YamlConfig;

  config.soulseek = {
    ...(config.soulseek ?? {}),
    username,
    password,
  };

  await slskd.options.updateYaml(stringify(config));
  await slskd.server.connect();
}
