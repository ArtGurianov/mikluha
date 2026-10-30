// Synthetic Cloud.ru qualification. Source-only: execution requires a separate owner GO covering
// writes AND deletion of the four exact keys printed by plan. Never uses real photos or app DB.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { env } from '../config.js';
import { S3MediaStorage, type StoredVariant } from '../media/storage.js';
import { digest, transform } from '../media/transform.js';

// An intentionally public synthetic 8px PNG (no person, copyright or consent data).
const source = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC',
  'base64',
);
const endpoint = env('MEDIA_S3_ENDPOINT'),
  bucket = env('MEDIA_S3_BUCKET');
const action = process.argv[2];
if (action !== 'plan' && action !== 'execute') throw new Error('USE_PLAN_OR_EXECUTE');
const id =
  action === 'plan'
    ? randomUUID()
    : (JSON.parse(await readFile(env('MEDIA_QUALIFICATION_PLAN'), 'utf8')) as { id: string }).id;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
  throw new Error('PLAN_INVALID');
const prefix = `media/v1/${id}/${digest(source)}`;
const processed = await transform(source);
const plan = {
  format: 'tour63-provider-qualification/1',
  id,
  endpoint,
  bucket,
  keys: [`${prefix}/original`, ...processed.map((v) => `${prefix}/${v.profile}.webp`)],
  variants: processed.map((v) => ({ profile: v.profile, sha256: v.sha256, bytes: v.bytes.length })),
};
if (action === 'plan') {
  console.log(JSON.stringify(plan, null, 2));
} else {
  const supplied = JSON.parse(await readFile(env('MEDIA_QUALIFICATION_PLAN'), 'utf8')) as unknown;
  if (
    JSON.stringify(supplied) !== JSON.stringify(plan) ||
    process.argv[3] !== '--owner-authorized-write-delete'
  )
    throw new Error('PLAN_OR_AUTHORIZATION_MISSING');
  const storage = new S3MediaStorage({
    endpoint,
    bucket,
    region: env('MEDIA_S3_REGION'),
    accessKeyId: env('MEDIA_S3_ACCESS_KEY_ID'),
    secretAccessKey: env('MEDIA_S3_SECRET_ACCESS_KEY'),
  });
  let attempted = false;
  let pass = false;
  let cleanup = true;
  try {
    await storage.assertConfiguration();
    attempted = true;
    await storage.privateWrite(plan.keys[0]!, source, 'application/octet-stream');
    for (const v of processed) {
      const key = `${prefix}/${v.profile}.webp`;
      await storage.privateWrite(key, v.bytes, 'image/webp');
      await storage.privateWrite(key, v.bytes, 'image/webp'); // exact replay must not overwrite
    }
    await storage.verifyPrivate(plan.keys[0]!);
    for (const v of processed) {
      const key = `${prefix}/${v.profile}.webp`;
      const variant: StoredVariant = {
        key,
        url: storage.url(key),
        sha256: v.sha256,
        bytes: v.bytes.length,
        width: v.width,
        height: v.height,
        profile: v.profile,
      };
      await storage.publish(variant);
    }
    pass = true;
  } catch {
    pass = false;
  } finally {
    if (attempted)
      for (const key of [...plan.keys].reverse()) {
        try {
          await storage.remove(key);
        } catch {
          cleanup = false;
        }
      }
    if (attempted)
      try {
        await storage.assertConfiguration();
      } catch {
        cleanup = false;
      }
  }
  console.log(
    JSON.stringify({
      format: plan.format,
      id,
      providerTransport: pass ? 'PASS' : 'FAIL',
      deletion: attempted ? (cleanup ? 'PASS' : 'UNCONFIRMED') : 'NOT_RUN',
      adminSsrInstallation: 'NOT_RUN',
      policyIamReadback: 'NOT_RUN',
      backupRestore: 'NOT_RUN',
      keys: plan.keys,
    }),
  );
  if (!pass || !cleanup) process.exitCode = 1;
}
