import { NavidromeClient } from './packages/navidrome-client/src/client.ts';
import { loadOrCreateSecrets } from './src/main.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

async function test() {
  const dataDir = process.env.NICOTIND_DATA_DIR || '~/.nicotind';
  const secrets = loadOrCreateSecrets(dataDir);
  
  const client = new NavidromeClient({
    baseUrl: 'http://localhost:4533',
    username: 'nicotind',
    password: secrets.navidromePassword,
  });

  console.log('Testing ping...');
  try {
    const ping = await client.requestRaw('ping.view');
    console.log('Ping status:', ping.status, await ping.text());
  } catch (e) {
    console.error('Ping failed:', e);
  }

  console.log('Fetching random album...');
  try {
    const listRes = await client.request('getAlbumList2.view', { type: 'newest', size: '1' });
    const albums = (listRes as any).albumList2?.album;
    if (albums && albums.length > 0) {
      const albumId = albums[0].id;
      console.log('Album:', albums[0]);
      
      const cover = await client.requestRaw('getCoverArt.view', { id: albumId });
      console.log('Cover status:', cover.status, cover.headers.get('content-type'));
    } else {
      console.log('No albums found.');
    }
  } catch (e) {
    console.error('Fetch failed:', e);
  }
}
test();
