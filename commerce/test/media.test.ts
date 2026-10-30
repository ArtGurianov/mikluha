import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { before, after, test } from 'node:test';
import { parseUpload, workOne, resolveMedia, UNAVAILABLE_IMAGE } from '../src/media/service.js';
import { transform, digest, MediaError } from '../src/media/transform.js';
import { type StoredVariant, type MediaStorage } from '../src/media/storage.js';
import { readPublicCatalog } from '../src/public-api.js';
import { createDecoderServer } from '../src/media/decoder-server.js';
import { freshDb, type TestDb } from './helpers.js';

let db: TestDb;
const python = process.env.MEDIA_PYTHON ?? '/opt/media-python/bin/python';
const source = () =>
  execFileSync(python, [
    '-c',
    `from PIL import Image; import io,sys
im=Image.new('RGB',(64,48),'red'); ex=Image.Exif(); ex[270]='PRIVATE-GPS-CAMERA'; b=io.BytesIO(); im.save(b,'JPEG',exif=ex); sys.stdout.buffer.write(b.getvalue())`,
  ]);
const decoder = createDecoderServer();
const socketDir = mkdtempSync(join(tmpdir(), 'media-rpc-'));
const socketPath = join(socketDir, 'decode.sock');
before(async () => {
  db = await freshDb();
  await new Promise<void>((r) => decoder.listen(socketPath, r));
  process.env.MEDIA_DECODER_SOCKET = socketPath;
});
after(async () => {
  decoder.closeAllConnections();
  await new Promise((r) => decoder.close(r));
  delete process.env.MEDIA_DECODER_SOCKET;
  rmSync(socketDir, { recursive: true, force: true });
  await db?.drop();
});
const input = (id = randomUUID()) => ({
  id,
  data: source().toString('base64'),
  alt: 'Алтай',
  credit: 'Автор',
  rightsBasis: 'CONSENT',
  rightsReference: 'consent-fixture-1',
  rightsConfirmed: true,
});
async function put(v = input()) {
  const p = parseUpload(v);
  await db.admin.query('SELECT fn_media_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    v.id,
    p.sha256,
    p.bytes,
    v.alt,
    v.credit,
    v.rightsBasis,
    v.rightsReference,
    'admin:fixture',
    v.rightsConfirmed,
  ]);
  return v;
}
const row = async (id: string) =>
  (await db.owner.query('SELECT * FROM media_asset WHERE id=$1', [id])).rows[0];

// Deterministic fault adapter tests worker state/transaction behavior. Separate HTTPS tests exercise
// the production S3 SDK transport; this is explicitly not Cloud.ru provider evidence.
class Store implements MediaStorage {
  objects = new Map<string, Buffer>();
  published = new Set<string>();
  fail = false;
  async assertConfiguration() {}
  async verifyPrivate(k: string) {
    assert.equal(this.published.has(k), false);
  }
  url(k: string) {
    return `https://s3.fixture.test/bucket/${k}`;
  }
  async privateWrite(k: string, b: Buffer) {
    if (this.fail) throw Error('OFFLINE');
    this.objects.set(k, b);
  }
  async readOriginal(k: string, sha: string) {
    if (this.fail) throw Error('OFFLINE');
    const bytes = this.objects.get(k)!;
    assert.equal(digest(bytes), sha);
    return bytes;
  }
  async publish(v: StoredVariant, b: Buffer) {
    if (this.fail) throw Error('OFFLINE');
    assert.equal(digest(b), v.sha256);
    this.objects.set(v.key, b);
    this.published.add(v.key);
  }
  async remove(k: string) {
    if (this.fail) throw Error('OFFLINE');
    this.objects.delete(k);
    this.published.delete(k);
  }
}

test('strict upload contract: bounds, canonical base64, rights, no client storage controls', () => {
  const v = input();
  assert.equal(parseUpload(v).bytes.length, source().length);
  for (const patch of [
    { alt: null },
    { credit: '' },
    { rightsBasis: null },
    { rightsReference: '' },
    { rightsConfirmed: false },
    { rightsConfirmed: null },
    { data: '@@' },
    { data: 'Zg=' },
    { data: '' },
    { bucket: 'public' },
    { url: 'http://169.254.169.254' },
    { id: '../x' },
  ])
    assert.throws(() => parseUpload({ ...v, ...patch }));
  assert.throws(() => parseUpload({ ...v, data: 'a'.repeat(12 * 1024 * 1024) }));
  // Large valid input must not hit V8's regexp recursion limit.
  assert.equal(
    parseUpload({ ...v, data: Buffer.alloc(8 * 1024 * 1024).toString('base64') }).bytes.length,
    8 * 1024 * 1024,
  );
});
test('real bounded decoder: WebP variants without source metadata, no upscaling', async () => {
  const variants = await transform(source());
  assert.equal(variants.length, 3);
  for (const v of variants) {
    assert.equal(v.width, 64);
    assert.equal(v.height, 48);
    assert.equal(v.bytes.includes(Buffer.from('PRIVATE-GPS-CAMERA')), false);
  }
  await assert.rejects(transform(Buffer.from('<svg onload="evil()"/>')));
  const gif = execFileSync(python, [
    '-c',
    "from PIL import Image; import io,sys; b=io.BytesIO(); Image.new('RGB',(2,2)).save(b,'GIF'); sys.stdout.buffer.write(b.getvalue())",
  ]);
  await assert.rejects(transform(gif));
  for (const snippet of [
    "Image.new('RGB',(8193,1)).save(b,'PNG')",
    "Image.new('RGB',(4001,4000)).save(b,'PNG')",
    "Image.new('RGB',(3,3),'red').save(b,'WEBP',save_all=True,append_images=[Image.new('RGB',(3,3),'blue')],duration=100,loop=0)",
  ]) {
    const unsafe = execFileSync(python, [
      '-c',
      `from PIL import Image; import io,sys; b=io.BytesIO(); ${snippet}; sys.stdout.buffer.write(b.getvalue())`,
    ]);
    await assert.rejects(transform(unsafe));
  }
});
test('actual EXIF GPS/orientation and ICC/XMP are removed from emitted WebP', async () => {
  const tagged = execFileSync(python, ['-c', `from PIL import Image; import io,sys
im=Image.new('RGB',(64,48),'red'); ex=Image.Exif(); ex[274]=6
ex[34853]={1:'N',2:(55.0,45.0,0.0),3:'E',4:(37.0,36.0,0.0)}
b=io.BytesIO(); im.save(b,'WEBP',exif=ex,icc_profile=b'PRIVATE-ICC',xmp=b'PRIVATE-XMP'); sys.stdout.buffer.write(b.getvalue())`]);
  const inspect = (bytes: Buffer) => JSON.parse(execFileSync(python, ['-c', `from PIL import Image; import io,sys,json
im=Image.open(io.BytesIO(sys.stdin.buffer.read())); e=im.getexif()
print(json.dumps({'gps':34853 in e,'orientation':e.get(274),'private':any(k in im.info for k in ('exif','icc_profile','xmp'))}))`], { input: bytes }).toString());
  assert.equal(inspect(tagged).gps, true, 'fixture contains real GPS IFD');
  assert.equal(inspect(tagged).orientation, 6);
  for (const v of await transform(tagged)) {
    assert.equal(v.width, 48);
    assert.equal(v.height, 64);
    assert.deepEqual(inspect(v.bytes), { gps: false, orientation: null, private: false });
  }
});
test('DB capability boundaries and NULL/wrong-type refusals', async () => {
  await assert.rejects(db.pool.query('SELECT * FROM media_asset'), /permission denied/);
  await assert.rejects(db.admin.query('SELECT * FROM media_asset'), /permission denied/);
  await assert.rejects(db.media.query('SELECT * FROM admin_user'), /permission denied/);
  await assert.rejects(
    db.media.query('SELECT fn_media_request($1,$2,$3)', [randomUUID(), 'PUBLISH', 'fake-owner']),
    /permission denied/,
  );
  await assert.rejects(
    db.admin.query('SELECT fn_media_request($1,$2,$3)', [randomUUID(), 'PUBLISH', 'editor']),
    /permission denied/,
  );
  await assert.rejects(db.publisher.query('SELECT fn_media_claim()'), /permission denied/);
  await assert.rejects(
    db.admin.query('SELECT fn_media_enqueue($1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)', [randomUUID()]),
  );
});
test('complete lifecycle: private READY, owner publication, immediate withdrawal, confirmed deletion', async () => {
  const v = await put();
  const storage = new Store();
  await put(v);
  assert.equal(
    (await db.owner.query('SELECT count(*) FROM media_asset WHERE id=$1', [v.id])).rows[0].count,
    '1',
  );
  await assert.rejects(put({ ...v, alt: 'changed' }), /MEDIA_IDEMPOTENCY_CONFLICT/);
  assert.equal(await workOne(db.media, storage), true);
  assert.equal((await row(v.id)).state, 'READY');
  assert.equal(storage.objects.size, 1, 'READY stores only a private original; no processed object yet');
  assert.equal(storage.published.size, 0);
  assert.equal((await db.pool.query('SELECT * FROM public_media WHERE id=$1', [v.id])).rowCount, 0);
  assert.equal((await row(v.id)).source_bytes, null);
  const dto = (await db.admin.query('SELECT * FROM admin_media WHERE id=$1', [v.id])).rows[0];
  assert.deepEqual(dto.variants, []);
  assert.equal('source_bytes' in dto, false);
  await db.publisher.query('SELECT fn_media_request($1,$2,$3)', [v.id, 'PUBLISH', 'admin:owner']);
  storage.fail = true;
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'PUBLISH_REQUESTED');
  storage.fail = false;
  await db.owner.query('UPDATE media_asset SET next_attempt_at=now() WHERE id=$1', [v.id]);
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'PUBLISHED');
  assert.equal(storage.published.size, 3);
  const publicRow = (await db.pool.query('SELECT * FROM public_media WHERE id=$1', [v.id])).rows[0];
  assert.equal(JSON.stringify(publicRow).includes('/original'), false);
  assert.equal(JSON.stringify(publicRow).includes('consent-fixture'), false);
  const assets = new Map([[v.id, publicRow]]);
  assert.match((resolveMedia({ image: `media:${v.id}` }, assets) as { image: string }).image, /1600.webp$/);
  assert.equal(resolveMedia('media:ordinary text', assets), 'media:ordinary text');
  const tourId = (await db.admin.query('SELECT fn_create_tour($1,$2) AS id', ['media-tour', 'fixture']))
    .rows[0].id;
  await db.admin.query('SELECT fn_save_tour_draft($1,0,$2,$3)', [
    tourId,
    {
      slug: 'media-tour',
      title: 'Media tour',
      isListed: true,
      contract: null,
      content: { coverImage: { image: `media:${v.id}`, alt: 'old alt' } },
    },
    'fixture',
  ]);
  await db.publisher.query('SELECT fn_publish_tour($1,1,0,$2)', [tourId, 'fixture']);
  const before = await readPublicCatalog(db.pool);
  assert.match(JSON.stringify(before.tours.find((t) => t.slug === 'media-tour')), /1600.webp/);
  assert.equal(JSON.stringify(before).includes('rights_reference'), false);
  await db.publisher.query('SELECT fn_media_request($1,$2,$3)', [v.id, 'REVOKE', 'admin:owner']);
  const after = await readPublicCatalog(db.pool);
  assert.equal(JSON.stringify(after).includes(`media:${v.id}`), false);
  assert.equal(JSON.stringify(after).includes(UNAVAILABLE_IMAGE), true);
  assert.equal((await db.pool.query('SELECT * FROM public_media WHERE id=$1', [v.id])).rowCount, 0);
  assert.equal(
    (resolveMedia({ image: `media:${v.id}` }, new Map()) as { image: string }).image,
    UNAVAILABLE_IMAGE,
  );
  storage.fail = true;
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'REVOKE_REQUESTED');
  storage.fail = false;
  await db.owner.query('UPDATE media_asset SET next_attempt_at=now() WHERE id=$1', [v.id]);
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'REVOKED');
  assert.equal(storage.objects.size, 0);
  await assert.rejects(
    db.publisher.query('SELECT fn_media_request($1,$2,$3)', [v.id, 'PUBLISH', 'admin:owner']),
    /MEDIA_STATE_CONFLICT/,
  );
});
test('withdrawal keeps retrying after the admission retry budget is exhausted', async () => {
  const v = await put();
  const storage = new Store();
  await workOne(db.media, storage);
  await db.publisher.query('SELECT fn_media_request($1,$2,$3)', [v.id, 'PUBLISH', 'admin:owner']);
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'PUBLISHED');
  await db.publisher.query('SELECT fn_media_request($1,$2,$3)', [v.id, 'REVOKE', 'admin:owner']);
  storage.fail = true;
  for (let i = 0; i < 7; i++) {
    await db.owner.query('UPDATE media_asset SET next_attempt_at=now() WHERE id=$1', [v.id]);
    assert.equal(await workOne(db.media, storage), true, `attempt ${i + 1} was claimed`);
  }
  const pending = await row(v.id);
  assert.deepEqual([pending.state, pending.attempts], ['REVOKE_REQUESTED', 5]);
  assert.ok(pending.next_attempt_at.getTime() > Date.now() + 10 * 60_000, 'backs off instead of spinning');
  storage.fail = false;
  await db.owner.query('UPDATE media_asset SET next_attempt_at=now() WHERE id=$1', [v.id]);
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'REVOKED');
  assert.equal(storage.published.size, 0);
});
test('invalid image is rejected before any storage write', async () => {
  const v = input();
  v.data = Buffer.from('not an image').toString('base64');
  await put(v);
  const storage = new Store();
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'REJECTED');
  assert.equal(storage.objects.size, 0);
  assert.equal((await row(v.id)).source_bytes, null);
});

test('an in-flight publication cannot resurrect media after committed OWNER withdrawal', async () => {
  const v = await put();
  const storage = new Store();
  await workOne(db.media, storage);
  await db.publisher.query('SELECT fn_media_request($1,$2,$3)', [v.id, 'PUBLISH', 'admin:owner']);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const publish = storage.publish.bind(storage);
  storage.publish = async (variant, bytes) => {
    entered();
    await gate;
    await publish(variant, bytes);
  };
  const processing = workOne(db.media, storage);
  await started;
  let revoked = false;
  const revoke = db.publisher
    .query('SELECT fn_media_request($1,$2,$3)', [v.id, 'REVOKE', 'admin:owner'])
    .then(() => {
      revoked = true;
    });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(revoked, false, 'withdrawal must serialize behind the held worker row lock');
  release();
  await processing;
  await revoke;
  assert.equal((await row(v.id)).state, 'REVOKE_REQUESTED');
  assert.equal((await db.pool.query('SELECT * FROM public_media WHERE id=$1', [v.id])).rowCount, 0);
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'REVOKED');
  assert.equal(storage.published.size, 0);
});

test('provider qualification plan is offline, exact-key and hash bounded, never an implicit write GO', async () => {
  const { stdout: output } = await promisify(execFile)(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'src/bin/media-qualification.ts', 'plan'],
    {
      env: {
        ...process.env,
        MEDIA_S3_ENDPOINT: 'https://s3.cloud.ru',
        MEDIA_S3_BUCKET: 'qualification-fixture',
        MEDIA_S3_PUBLIC_ORIGIN: 'https://qualification-global-name.s3.cloud.ru',
        MEDIA_S3_PRINCIPAL_ARN: 'arn:aws:iam::synthetic:service_account/synthetic',
      },
      encoding: 'utf8',
    },
  );
  const plan = JSON.parse(output);
  assert.equal(plan.keys.length, 4);
  assert.equal(plan.variants.length, 3);
  assert.ok(plan.keys.every((k: string) => k.startsWith(`media/v1/${plan.id}/`)));
  assert.ok(plan.variants.every((v: { sha256: string }) => /^[0-9a-f]{64}$/.test(v.sha256)));
  assert.equal(output.includes('secretAccessKey'), false);
});
test('unconfirmed private-original admission automatically quarantines and confirms cleanup', async () => {
  const v = await put();
  const storage = new Store();
  storage.privateWrite = async (k, b) => {
    storage.objects.set(k, b);
    throw new MediaError('MEDIA_PRIVACY_UNCONFIRMED', 503);
  };
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'REVOKE_REQUESTED');
  assert.equal((await row(v.id)).source_bytes, null);
  assert.equal((await row(v.id)).last_error, 'PRIVACY_UNCONFIRMED');
  await workOne(db.media, storage);
  assert.equal((await row(v.id)).state, 'REVOKED');
  assert.equal(storage.objects.size, 0);
});
test('staging capacity is bounded and withdrawal frees staging without allowing resurrection', async () => {
  const values = Array.from({ length: 32 }, () => ({
    ...input(),
    data: Buffer.from('invalid fixture').toString('base64'),
  }));
  await Promise.all(values.map((v) => put(v)));
  await assert.rejects(
    put({ ...input(), data: Buffer.from('overflow').toString('base64') }),
    /MEDIA_QUEUE_FULL/,
  );
  await db.publisher.query('SELECT fn_media_request($1,$2,$3)', [values[0]!.id, 'REVOKE', 'admin:owner']);
  await put({ ...input(), data: Buffer.from('space freed').toString('base64') });
  assert.equal(
    (await db.owner.query('SELECT count(*) FROM media_asset WHERE source_bytes IS NOT NULL')).rows[0].count,
    '32',
  );
});
