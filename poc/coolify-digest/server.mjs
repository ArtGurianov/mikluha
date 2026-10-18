// The PoC's whole application: it reports the commit it was built from, and nothing else.
import { createServer } from 'node:http';

const identity = JSON.stringify({ service: 'mikluha-digest-poc', commit: process.env.SOURCE_COMMIT ?? null });

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/identity') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(identity);
  } else {
    res.writeHead(404).end();
  }
}).listen(3000);
