import * as fs from 'node:fs';
const secrets = JSON.parse(fs.readFileSync('/home/kevinch3/.nicotind/secrets.json', 'utf8'));

async function fetchSwagger() {
  try {
    const res = await fetch('http://localhost:5030/swagger/v1/swagger.json', {
      headers: { 'X-API-KEY': secrets.slskdPassword }
    });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    const routes = Object.keys(data.paths).filter(p => p.includes('transfer') && p.includes('download'));
    
    for (const route of routes) {
      console.log(route);
      console.log(Object.keys(data.paths[route]));
    }
  } catch(e) { console.error('Error fetching swagger:', e); }
}

fetchSwagger();
