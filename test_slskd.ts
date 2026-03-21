import { Slskd } from './packages/slskd-client/src/index.ts';
import { loadOrCreateSecrets } from './src/main.ts';

async function test() {
  const dataDir = process.env.NICOTIND_DATA_DIR || '~/.nicotind';
  const secrets = loadOrCreateSecrets(dataDir);
  
  const client = new Slskd({
    baseUrl: 'http://localhost:5030',
    username: 'nicotind',
    password: secrets.slskdPassword,
  });

  try {
    const downloads = await client.transfers.getDownloads();
    console.log(JSON.stringify(downloads, null, 2));

    if (downloads.length > 0 && downloads[0].directories.length > 0 && downloads[0].directories[0].files.length > 0) {
        const username = downloads[0].username;
        const id = downloads[0].directories[0].files[0].id;
        console.log(`Trying to cancel ${username} ${id}...`);
        
        const res = await client['client'].requestRaw(`/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        console.log('Cancel status:', res.status, await res.text());
        
        const postCancel = await client.transfers.getDownloads();
        console.log('Post cancel files:', postCancel[0].directories[0].files.length);
    }
  } catch (e) {
    console.error('Test failed:', e);
  }
}
test();
