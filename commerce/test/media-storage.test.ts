// Real HTTPS + SigV4 transport against a disposable S3 protocol fixture, not provider qualification.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { S3MediaStorage, PUBLIC_CACHE, type StoredVariant } from '../src/media/storage.js';
import { decodeIsolated } from '../src/media/decoder.js';
import { publicVariantPolicy, assertPublicVariantPolicy } from '../src/media/policy.js';
import { digest } from '../src/media/transform.js';

let server: Server, endpoint: string, store: S3MediaStorage;
const objects = new Map<string, { body: Buffer; mime: string; cache: string; public: boolean }>();
const key = 'media/v1/12345678-1234-4234-8234-123456789abc/' + 'a'.repeat(64) + '/480.webp';
let versioned = false,
  badMime = false,
  badCors = false,
  failDelete = false;
function authenticated(req: IncomingMessage, body: Buffer): boolean {
  const match =
    /^AWS4-HMAC-SHA256 Credential=fixture-key\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(
      req.headers.authorization ?? '',
    );
  if (!match) return false;
  const [date, region, service, last] = match[1]!.split('/');
  if (service !== 's3' || last !== 'aws4_request') return false;
  const u = new URL(req.url!, endpoint);
  const query = [...u.searchParams]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => a[0]!.localeCompare(b[0]!))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const headers = match[2]!
    .split(';')
    .map(
      (k) =>
        `${k}:${String(req.headers[k] ?? '')
          .trim()
          .replace(/\s+/g, ' ')}\n`,
    )
    .join('');
  const payload = String(req.headers['x-amz-content-sha256']);
  if (payload !== 'UNSIGNED-PAYLOAD' && payload !== digest(body)) return false;
  const canonical = [req.method, u.pathname, query, headers, match[2], payload].join('\n');
  const string = [
    'AWS4-HMAC-SHA256',
    req.headers['x-amz-date'],
    match[1],
    digest(Buffer.from(canonical)),
  ].join('\n');
  const h = (k: Buffer | string, v: string) => createHmac('sha256', k).update(v).digest();
  const signing = h(h(h(h('AWS4fixture-secret', date!), region!), service!), last!);
  return h(signing, string).toString('hex') === match[3];
}
before(async () => {
  server = createServer(
    {
      key: readFileSync(process.env.MEDIA_TEST_TLS_KEY!),
      cert: readFileSync(process.env.MEDIA_TEST_TLS_CERT!),
    },
    async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const u = new URL(req.url!, endpoint);
      const auth = authenticated(req, body);
      const k = u.pathname.slice('/fixture-bucket/'.length);
      const error = (status: number, code: string) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
      };
      if (req.headers.authorization && !auth) {
        error(403, 'SignatureDoesNotMatch');
        return;
      }
      if (u.searchParams.has('policy') && auth) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(publicVariantPolicy('fixture-bucket')));
        return;
      }
      if (u.searchParams.has('ownershipControls') && auth) {
        res.end(
          '<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>',
        );
        return;
      }
      if (u.searchParams.has('acl') && req.method === 'GET' && auth) {
        res.end(
          '<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>',
        );
        return;
      }
      if (u.searchParams.has('versioning') && auth) {
        res.end(
          `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${versioned ? '<Status>Enabled</Status>' : ''}</VersioningConfiguration>`,
        );
        return;
      }
      if (req.method === 'PUT' && auth) {
        if (u.searchParams.has('acl')) {
          error(501, 'NotImplemented');
          return;
        }
        if (objects.has(k) && req.headers['if-none-match'] === '*') {
          error(412, 'PreconditionFailed');
          return;
        }
        objects.set(k, {
          body,
          mime: String(req.headers['content-type']),
          cache: String(req.headers['cache-control']),
          public: /\/(480|960|1600)\.webp$/.test(k),
        });
        res.end();
        return;
      }
      if (req.method === 'DELETE' && auth) {
        if (failDelete) {
          error(503, 'ServiceUnavailable');
          return;
        }
        objects.delete(k);
        res.writeHead(204);
        res.end();
        return;
      }
      const o = objects.get(k);
      if (!o) {
        error(404, 'NoSuchKey');
        return;
      }
      if (!auth && !o.public) {
        error(403, 'AccessDenied');
        return;
      }
      res.writeHead(200, {
        'content-type': badMime ? 'text/html' : o.mime,
        'cache-control': o.cache,
        'content-length': o.body.length,
        'access-control-allow-origin': badCors ? 'https://evil.test' : 'https://mikluha-maklai.ru',
      });
      res.end(o.body);
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  store = new S3MediaStorage({
    endpoint,
    bucket: 'fixture-bucket',
    region: 'test',
    accessKeyId: 'fixture-key',
    secretAccessKey: 'fixture-secret',
  });
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
test('TLS + SigV4 conditional writes, anonymous denial, verified public WebP, confirmed deletion', async () => {
  await store.assertConfiguration();
  versioned = true;
  await assert.rejects(store.assertConfiguration(), /MEDIA_VERSIONING_UNSUPPORTED/);
  versioned = false;
  const originalBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC',
    'base64',
  );
  const body = (await decodeIsolated(originalBytes))[0]!.bytes;
  const original = key.replace('480.webp', 'original');
  await store.privateWrite(original, originalBytes, 'application/octet-stream');
  assert.equal((await fetch(store.url(original))).status, 403);
  assert.equal((await fetch(store.url(key))).status, 404, 'prepared WebP is not uploaded before publish');
  await store.privateWrite(original, originalBytes, 'application/octet-stream');
  await assert.rejects(
    store.privateWrite(original, Buffer.from('changed'), 'application/octet-stream'),
    /MEDIA_IMMUTABLE_CONFLICT|MEDIA_READBACK/,
  );
  const v: StoredVariant = {
    key,
    url: store.url(key),
    sha256: digest(body),
    bytes: body.length,
    width: 1,
    height: 1,
    profile: 480,
  };
  badMime = true;
  await assert.rejects(store.publish(v, body), /MEDIA_PUBLIC_READBACK/);
  badMime = false;
  badCors = true;
  await assert.rejects(store.publish(v, body), /MEDIA_PUBLIC_READBACK/);
  badCors = false;
  await store.publish(v, body);
  await store.publish(v, body);
  await assert.rejects(store.publish(v, Buffer.from('tampered')), /MEDIA_VARIANT_INVALID/);
  const response = await fetch(v.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), PUBLIC_CACHE);
  await assert.rejects(
    store.publish({ ...v, key: original, url: store.url(original) }, body),
    /MEDIA_ORIGINAL_PRIVATE/,
  );
  failDelete = true;
  await assert.rejects(store.remove(key));
  failDelete = false;
  await store.remove(key);
  assert.equal((await fetch(v.url)).status, 404);
  await store.remove(key);
});
test('unsafe storage configuration and client-selected keys are refused', () => {
  assert.throws(
    () =>
      new S3MediaStorage({
        endpoint: 'http://127.0.0.1',
        bucket: 'fixture-bucket',
        region: 'test',
        accessKeyId: 'k',
        secretAccessKey: 's',
      }),
  );
  const remote = new S3MediaStorage({
    endpoint: 'https://s3.cloud.ru',
    bucket: 'synthetic-bucket',
    publicOrigin: 'https://different-global-name.s3.cloud.ru',
    region: 'test',
    accessKeyId: 'k',
    secretAccessKey: 's',
  });
  assert.equal(remote.url(key), `https://different-global-name.s3.cloud.ru/${key}`);
  assert.throws(() => store.url('../../secret'));
  assert.throws(() => store.url('media/v1/private'));
});

test('only the exact three processed WebP paths may be publicly readable', () => {
  const good = publicVariantPolicy('fixture-bucket');
  assertPublicVariantPolicy(JSON.stringify(good), 'fixture-bucket');
  assertPublicVariantPolicy(JSON.stringify({...good,Statement:[{...good.Statement[0],NotPrincipal:{},NotAction:[],NotResource:[],Condition:{}}]}),'fixture-bucket');
  for (const change of [
    { Resource: ['arn:aws:s3:::fixture-bucket/*'] },
    { Action: ['s3:GetObject', 's3:PutObject'] },
    { Principal: { AWS: '*' } },
    { NotResource: 'anything' },
  ])
    assert.throws(() =>
      assertPublicVariantPolicy(
        JSON.stringify({ ...good, Statement: [{ ...good.Statement[0], ...change }] }),
        'fixture-bucket',
      ),
    );
  assert.throws(() => assertPublicVariantPolicy(undefined, 'fixture-bucket'));
});


test('worker policy requires the enrolled private-read grant and key/bucket mutation fences', () => {
  const principal = 'arn:aws:iam::11111111-1111-4111-8111-111111111111:service_account/22222222-2222-4222-8222-222222222222';
  const good = publicVariantPolicy('fixture-bucket', principal);
  assertPublicVariantPolicy(JSON.stringify(good), 'fixture-bucket', principal);
  for (let index = 1; index < good.Statement.length; index++) {
    assert.throws(() => assertPublicVariantPolicy(JSON.stringify({ ...good,
      Statement: good.Statement.filter((_, i) => i !== index),
    }), 'fixture-bucket', principal));
    assert.throws(() => assertPublicVariantPolicy(JSON.stringify({ ...good,
      Statement: good.Statement.map((s, i) => i === index ? { ...s, Condition: { StringEquals: { 'aws:SourceIp': '127.0.0.1' } } } : s),
    }), 'fixture-bucket', principal));
  }
  assert.throws(() => assertPublicVariantPolicy(JSON.stringify(good), 'fixture-bucket', principal.replace('22222222-', '33333333-')));
});
