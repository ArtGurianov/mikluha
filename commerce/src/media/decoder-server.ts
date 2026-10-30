import { createServer } from 'node:http';
import { decodeIsolated } from './decoder.js';
import { MAX_SOURCE_BYTES, MediaError } from './transform.js';
/** Credential-free, one active decode, bounded stream. Only the private worker network reaches it. */
export function createDecoderServer() {
  let busy = false;
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz' && req.method === 'GET') {
      reply(200, { ok: true });
      return;
    }
    if (req.url !== '/transform' || req.method !== 'POST') {
      reply(404, { error: 'NOT_FOUND' });
      return;
    }
    if (busy) {
      reply(503, { error: 'BUSY' });
      return;
    }
    if (
      req.headers['content-type'] !== 'application/octet-stream' ||
      Number(req.headers['content-length']) > MAX_SOURCE_BYTES
    ) {
      reply(422, { error: 'IMAGE_REJECTED' });
      return;
    }
    busy = true;
    const timer = setTimeout(() => req.destroy(), 10_000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_SOURCE_BYTES) {
          req.destroy();
          throw new Error('SIZE');
        }
        chunks.push(Buffer.from(chunk));
      }
      clearTimeout(timer);
      const variants = await decodeIsolated(Buffer.concat(chunks));
      reply(
        200,
        variants.map((v) => ({
          profile: v.profile,
          width: v.width,
          height: v.height,
          data: v.bytes.toString('base64'),
        })),
      );
    } catch (e) {
      if (!res.destroyed)
        reply(e instanceof MediaError && e.status === 422 ? 422 : 503, {
          error: 'DECODE_FAILED',
        });
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  });
  server.requestTimeout = 12_000;
  server.headersTimeout = 10_000;
  return server;
}
