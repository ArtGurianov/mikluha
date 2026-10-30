import type pg from 'pg';
import { digest, MAX_SOURCE_BYTES, MediaError, transform } from './transform.js';
import type { MediaStorage, StoredVariant } from './storage.js';

export interface Upload {
  id: string;
  data: string;
  alt: string;
  credit: string;
  rightsBasis: 'OWNED' | 'CONSENT';
  rightsReference: string;
  rightsConfirmed: true;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseUpload(v: Record<string, unknown>): { upload: Upload; bytes: Buffer; sha256: string } {
  if (
    Object.keys(v).some(
      (k) =>
        !['id', 'data', 'alt', 'credit', 'rightsBasis', 'rightsReference', 'rightsConfirmed'].includes(k),
    ) ||
    typeof v.id !== 'string' ||
    !UUID.test(v.id) ||
    typeof v.data !== 'string' ||
    v.data.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data) ||
    !['alt', 'credit', 'rightsReference'].every(
      (k) =>
        typeof v[k] === 'string' &&
        (v[k] as string).trim().length > 0 &&
        (v[k] as string).length <= (k === 'rightsReference' ? 1000 : 500),
    ) ||
    v.rightsConfirmed !== true ||
    (v.rightsBasis !== 'OWNED' && v.rightsBasis !== 'CONSENT')
  )
    throw new MediaError('MEDIA_INVALID');
  const bytes = Buffer.from(v.data, 'base64');
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES || bytes.toString('base64') !== v.data)
    throw new MediaError('MEDIA_SIZE');
  return { upload: v as unknown as Upload, bytes, sha256: digest(bytes) };
}
export async function enqueue(
  client: pg.PoolClient,
  value: Record<string, unknown>,
  actor: string,
): Promise<string> {
  const { upload: u, bytes, sha256 } = parseUpload(value);
  await client.query('SELECT fn_media_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    u.id,
    sha256,
    bytes,
    u.alt,
    u.credit,
    u.rightsBasis,
    u.rightsReference,
    actor,
    u.rightsConfirmed,
  ]);
  return u.id;
}
interface Claimed {
  id: string;
  source_sha256: string;
  source_bytes: Buffer | null;
  state: string;
  variants: StoredVariant[];
}
export const mediaPrefix = (row: { id: string; source_sha256: string }) =>
  `media/v1/${row.id}/${row.source_sha256}`;
/** The bounded worker alone holds storage credentials. Claim + IO + final state are serialized. */
export async function workOne(pool: pg.Pool, storage: MediaStorage): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='90s'");
    const row = (await client.query<Claimed>('SELECT * FROM fn_media_claim()')).rows[0];
    if (!row) {
      await client.query('COMMIT');
      return false;
    }
    const prefix = mediaPrefix(row);
    try {
      await storage.assertConfiguration();
      let state: string;
      let variants = row.variants;
      if (row.state === 'UPLOADED') {
        if (!row.source_bytes || digest(row.source_bytes) !== row.source_sha256)
          throw new MediaError('MEDIA_IMAGE_REJECTED');
        // Decode before writing any bytes to S3. Invalid input is never uploaded.
        const processed = await transform(row.source_bytes);
        await storage.privateWrite(`${prefix}/original`, row.source_bytes, 'application/octet-stream');
        variants = [];
        for (const v of processed) {
          const key = `${prefix}/${v.profile}.webp`;
          await storage.privateWrite(key, v.bytes, 'image/webp');
          variants.push({
            key,
            url: storage.url(key),
            sha256: v.sha256,
            bytes: v.bytes.length,
            profile: v.profile,
            width: v.width,
            height: v.height,
          });
        }
        state = 'READY';
      } else if (row.state === 'PUBLISH_REQUESTED') {
        await storage.verifyPrivate(`${prefix}/original`);
        for (const variant of variants) await storage.publish(variant);
        state = 'PUBLISHED';
      } else {
        // Fixed known keys, not a client prefix/list operation. Partial/unknown deletion stays pending.
        for (const name of ['480.webp', '960.webp', '1600.webp', 'original'])
          await storage.remove(`${prefix}/${name}`);
        await storage.assertConfiguration();
        state = 'REVOKED';
      }
      await client.query('SELECT fn_media_complete($1,$2,$3)', [row.id, state, JSON.stringify(variants)]);
    } catch (e) {
      if (
        e instanceof MediaError &&
        e.code === 'MEDIA_PRIVACY_UNCONFIRMED' &&
        ['UPLOADED', 'PUBLISH_REQUESTED'].includes(row.state)
      ) {
        await client.query('SELECT fn_media_quarantine($1)', [row.id]);
      } else if (e instanceof MediaError && e.code === 'MEDIA_IMAGE_REJECTED' && row.state === 'UPLOADED') {
        await client.query('SELECT fn_media_complete($1,$2,$3)', [
          row.id,
          'REJECTED',
          JSON.stringify(row.variants),
        ]);
      } else {
        await client.query('SELECT fn_media_retry($1)', [row.id]);
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export const UNAVAILABLE_IMAGE = '/media/image-unavailable.svg';
/** Only image fields are references; a title/paragraph that starts with "media:" stays text.
 * Required cover images must remain renderable after withdrawal; the local neutral placeholder
 * has no link to the original and prevents a revoked gallery from failing the whole SSR catalog.
 */
export function resolveMedia(
  value: unknown,
  assets: Map<string, { alt: string; variants: StoredVariant[] }>,
): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveMedia(v, assets));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const resolved = Object.fromEntries(Object.entries(object).map(([k, v]) => [k, resolveMedia(v, assets)]));
    if (typeof object.image === 'string' && object.image.startsWith('media:')) {
      const asset = assets.get(object.image.slice(6));
      const variant = asset?.variants.find((v) => v.profile === 1600);
      resolved.image = variant?.url ?? UNAVAILABLE_IMAGE;
      resolved.alt = variant ? asset!.alt : 'Фотография недоступна';
    }
    return resolved;
  }
  return value;
}
