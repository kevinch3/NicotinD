import type { LidarrClient } from '@nicotind/lidarr-client';

type LidarrConfig = {
  bindUrl?: string;
  apiKey?: string;
  authenticationMethod?: string;
  analytics?: boolean;
  urlBase?: string;
};

export async function updateExternalLidarrCredentials(
  lidarr: LidarrClient,
  apiKey: string,
): Promise<void> {
  const config = (await lidarr.request<LidarrConfig>('/api/v1/config', {
    headers: { 'X-Api-Key': lidarr['apiKey'] },
  })) as Record<string, unknown>;

  (config as Record<string, unknown>)['apiKey'] = apiKey;

  await lidarr.request('/api/v1/config', {
    method: 'PUT',
    headers: { 'X-Api-Key': lidarr['apiKey'], 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}
