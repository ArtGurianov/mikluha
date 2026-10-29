/* global ngx */
// A bounded admission step INSIDE the same NGINX, before disk cache population.
// Never interpolate client input into an upstream URL. Manifest is generated offline.
import crypto from 'crypto';
import objects from '/etc/nginx/objects.mjs';

async function serve(r) {
  const object = objects[r.uri];
  if (!object) { r.return(404); return; }
  let reply;
  try {
    reply = await ngx.fetch(object.url, {
      max_response_body_size: 1048576,
      verify: true,
      // Only the fixed manifest validator can reach S3, not browser headers.
      headers: r.headersIn['If-None-Match'] === `"${object.sha256}"`
        ? { 'If-None-Match': object.etag } : {},
    });
    if (reply.status === 304 && r.headersIn['If-None-Match'] === `"${object.sha256}"`) {
      r.headersOut.ETag = `"${object.sha256}"`;
      r.return(304); return;
    }
    if (reply.status !== 200) {
      r.return([403, 404, 500, 502, 503, 504].includes(reply.status) ? reply.status : 502);
      return;
    }
    if (reply.headers.get('Content-Type')?.toLowerCase() !== 'image/webp') {
      r.return(415); return;
    }
    if (reply.headers.get('Set-Cookie') || /\b(private|no-store)\b/i.test(reply.headers.get('Cache-Control') || '')) {
      r.return(502); return;
    }
    const bytes = Buffer.from(await reply.arrayBuffer());
    if (bytes.length > 1048576 || crypto.createHash('sha256').update(bytes).digest('hex') !== object.sha256) {
      r.return(502); return;
    }
    r.headersOut['Content-Type'] = 'image/webp';
    r.headersOut.ETag = `"${object.sha256}"`;
    r.headersOut['Last-Modified'] = object.lastModified;
    r.return(200, bytes);
  } catch (error) {
    // njs 1.0.2 enforces the bound for Content-Length AND chunked responses.
    r.return(String(error).includes('timed out') ? 504 : 502);
  }
}
const gate = { serve };
export default gate;
