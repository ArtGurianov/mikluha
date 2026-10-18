// The PoC's whole application: it reports the commit it was built from, and nothing else.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

// Baked at build time: Coolify overrides SOURCE_COMMIT at runtime with HEAD.
const identity = JSON.stringify({ service: 'mikluha-digest-poc', commit: readFileSync('/app/commit', 'utf8') });

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/identity') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(identity);
  } else {
    res.writeHead(404).end();
  }
}).listen(3000);
