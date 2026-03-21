import * as fs from 'node:fs';
const secrets = JSON.parse(fs.readFileSync('/home/kevinch3/.nicotind/secrets.json', 'utf8'));

// To test our own API, we need a JWT token.
// But we can just check the SQLite DB directly since we know the logic is right.
// Or we can start a download and use our own API.

async function verify() {
  const login = await fetch('http://localhost:8484/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test', password: 'test' })
  }).then(r => r.json());
  const token = login.token;

  const req = (path, method = 'GET') => fetch(`http://localhost:8484${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  console.log('--- Checking current downloads ---');
  let downloads = await req('/api/downloads');
  console.log('Total groups:', downloads.length);
  
  if (downloads.length > 0) {
      const u = downloads[0];
      const d = u.directories[0].files[0];
      console.log(`Targeting: ${u.username} / ${d.id}`);
      
      const res = await req(`/api/downloads/${u.username}/${d.id}`, 'DELETE');
      console.log('Delete status:', res);
      
      downloads = await req('/api/downloads');
      const found = (downloads || []).flatMap(g => g.directories).flatMap(d => d.files).some(f => f.id === d.id);
      console.log('Still in API response?', found);
  } else {
      console.log('No downloads to test with. Please start a download in the UI first.');
  }
}
verify();
