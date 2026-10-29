// Synthetic public/private origin. No credentials and no real tourist photographs.
import http from 'node:http';
import { createHash } from 'node:crypto';
const bytes = Buffer.from('RIFF synthetic WebP fixture (not a real photograph)');
const digest = createHash('sha256').update(bytes).digest('hex');
const counts = {};
let outage = false;
const server = http.createServer(async (req, res) => {
  if (req.url === '/__stats') return res.end(JSON.stringify(counts));
  if (req.url === '/__down') { outage = true; return res.end('ok'); }
  if (req.url === '/__up') { outage = false; return res.end('ok'); }
  counts[req.url] = (counts[req.url] ?? 0) + 1;
  if (req.url === '/originals/exists.jpg') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end('private sentinel: deliberately readable at fixture origin; cache must deny it');
  }
  const match = new RegExp(`^/processed/${digest}/([a-z-]+)\\.webp$`).exec(req.url ?? '');
  if (!match) { res.writeHead(404); return res.end(); }
  const name = match[1];
  if (outage || name === 'error') { res.writeHead(503); return res.end('unavailable'); }
  if (name === 'missing') { res.writeHead(404); return res.end(); }
  if (name === 'timeout') await new Promise(r => setTimeout(r, 1400));
  if (name === 'collapse') await new Promise(r => setTimeout(r, 150));
  const etag = `"${digest}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag }); return res.end();
  }
  const body = name === 'oversize' ? Buffer.alloc(2 * 1024 * 1024, 97) : bytes;
  res.writeHead(200, {
    'Content-Type': name === 'wrong-type' ? 'text/html' : 'image/webp',
    'Content-Length': body.length,
    ETag: etag,
    'Last-Modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
    ...(name === 'cookie' ? { 'Set-Cookie': 'synthetic=1' } : {}),
    ...(name === 'private' ? { 'Cache-Control': 'private, no-store' } : {}),
    ...(name === 'redirect' ? { 'X-Accel-Redirect': '/originals/exists.jpg' } : {}),
    // Detect whether an attacker could vary an upstream response through headers.
    ...(req.headers['x-forwarded-host'] ? { Vary: 'X-Forwarded-Host' } : {}),
  });
  res.end(body);
});
server.listen(8080, '0.0.0.0');
