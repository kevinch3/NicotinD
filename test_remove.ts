import * as fs from 'node:fs';
const secrets = JSON.parse(fs.readFileSync('/home/kevinch3/.nicotind/secrets.json', 'utf8'));

async function testClear() {
  const login = await fetch('http://localhost:5030/api/v0/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nicotind', password: secrets.slskdPassword })
  }).then(r => r.json());
  const token = login.token;

  const req = (path, method = 'GET') => fetch(`http://localhost:5030/api/v0${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.text().then(t => {
      try { return t ? JSON.parse(t) : { status: r.status }; }
      catch(e) { return { status: r.status, text: t }; }
  }));

  let downloads = await req('/transfers/downloads');
  if (downloads.length === 0) return console.log('No downloads to test.');
  
  const u = downloads[0];
  console.log(`TEST: DELETE /api/v0/transfers/downloads/${u.username}/completed`);
  const res = await req(`/transfers/downloads/${u.username}/completed`, 'DELETE');
  console.log('Result:', res);

  downloads = await req('/transfers/downloads');
  console.log('Remaining users:', downloads.length);
}
testClear();
