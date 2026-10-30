import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetBucketPolicyCommand,
  GetBucketAclCommand,
  GetBucketOwnershipControlsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { assertPublicVariantPolicy } from './policy.js';
import { digest, MediaError } from './transform.js';

export const PUBLIC_CACHE = 'public, max-age=60, must-revalidate';
export interface StoredVariant {
  key: string;
  url: string;
  sha256: string;
  bytes: number;
  profile: number;
  width: number;
  height: number;
}
export interface MediaStorage {
  assertConfiguration(): Promise<void>;
  privateWrite(key: string, body: Buffer, contentType: string): Promise<void>;
  verifyPrivate(key: string): Promise<void>;
  readOriginal(key: string, sha256: string): Promise<Buffer>;
  publish(variant: StoredVariant, body: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
  url(key: string): string;
}
export interface StorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicOrigin?: string;
  principalArn?: string;
}
/** No request selects an endpoint, bucket, key, URL, ACL or cache policy. */
export class S3MediaStorage implements MediaStorage {
  private readonly client: S3Client;
  private readonly endpoint: URL;
  private readonly publicBase: string;
  constructor(private readonly config: StorageConfig) {
    this.endpoint = new URL(config.endpoint);
    if (
      this.endpoint.protocol !== 'https:' ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.pathname !== '/' ||
      this.endpoint.search ||
      this.endpoint.hash ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !config.region ||
      !config.accessKeyId ||
      !config.secretAccessKey ||
      (config.principalArn !== undefined &&
        !/^arn:aws:iam::[0-9a-f-]{36}:service_account\/[0-9a-f-]{36}$/.test(config.principalArn))
    )
      throw new Error('MEDIA_STORAGE_CONFIG');
    // Local bucket names and public global/domain names may differ on Cloud.ru.
    // The operator enrolls the verified public origin; never derive it from the local bucket name.
    if (['127.0.0.1', 'localhost'].includes(this.endpoint.hostname) && !config.publicOrigin) {
      this.publicBase = `${this.endpoint.origin}/${config.bucket}`;
    } else {
      if (!config.publicOrigin) throw new Error('MEDIA_PUBLIC_ORIGIN_REQUIRED');
      const publicUrl = new URL(config.publicOrigin);
      if (
        publicUrl.protocol !== 'https:' ||
        publicUrl.origin !== config.publicOrigin ||
        !publicUrl.hostname.endsWith(`.${this.endpoint.hostname}`)
      )
        throw new Error('MEDIA_PUBLIC_ORIGIN_CONFIG');
      this.publicBase = publicUrl.origin;
    }
    this.client = new S3Client({
      endpoint: this.endpoint.origin,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  private key(key: string): void {
    if (!/^media\/v1\/[0-9a-f-]{36}\/[0-9a-f]{64}\/(original|(?:480|960|1600)\.webp)$/.test(key))
      throw new Error('MEDIA_KEY');
  }
  url(key: string): string {
    this.key(key);
    return `${this.publicBase}/${key}`;
  }
  async assertConfiguration(): Promise<void> {
    const v = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.config.bucket }), {
      abortSignal: AbortSignal.timeout(10_000),
    });
    // Suspended buckets retain versions too: deletion confirmation would be incomplete.
    if (v.Status !== undefined) throw new Error('MEDIA_VERSIONING_UNSUPPORTED');
    const [policy, acl, ownership] = await Promise.all([
      this.client.send(new GetBucketPolicyCommand({ Bucket: this.config.bucket }), {
        abortSignal: AbortSignal.timeout(10_000),
      }),
      this.client.send(new GetBucketAclCommand({ Bucket: this.config.bucket }), {
        abortSignal: AbortSignal.timeout(10_000),
      }),
      this.client.send(new GetBucketOwnershipControlsCommand({ Bucket: this.config.bucket }), {
        abortSignal: AbortSignal.timeout(10_000),
      }),
    ]);
    assertPublicVariantPolicy(policy.Policy, this.config.bucket, this.config.principalArn);
    if (!acl.Grants?.length || acl.Grants.some((g) => g.Grantee?.Type !== 'CanonicalUser'))
      throw new Error('MEDIA_ACL_UNCONFIRMED');
    if (
      ownership.OwnershipControls?.Rules?.length !== 1 ||
      ownership.OwnershipControls.Rules[0]?.ObjectOwnership !== 'BucketOwnerEnforced'
    )
      throw new Error('MEDIA_OWNERSHIP_UNCONFIRMED');
  }
  private async anonymous(key: string, cors = false): Promise<Response> {
    return fetch(this.url(key), {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
      headers: cors ? { Origin: 'https://mikluha-maklai.ru' } : {},
    });
  }
  private async denied(key: string): Promise<void> {
    const response = await this.anonymous(key);
    await response.body?.cancel();
    if (response.status !== 403 && response.status !== 404)
      throw new MediaError('MEDIA_PRIVACY_UNCONFIRMED', 503);
  }
  async verifyPrivate(key: string): Promise<void> {
    this.key(key);
    try {
      await this.denied(key);
    } catch {
      throw new MediaError('MEDIA_PRIVACY_UNCONFIRMED', 503);
    }
  }
  private async read(key: string, max: number): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(10_000),
    });
    if (!r.Body || r.ContentLength === undefined || r.ContentLength > max) {
      if (r.Body && 'destroy' in r.Body) r.Body.destroy();
      throw new Error('MEDIA_READBACK');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of r.Body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > max) throw new Error('MEDIA_READBACK');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  private async writeOnce(key: string, body: Buffer, contentType: string, cache: string): Promise<void> {
    this.key(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cache,
          IfNoneMatch: '*',
        }),
        { abortSignal: AbortSignal.timeout(10_000) },
      );
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw e;
    }
    if (digest(await this.read(key, body.length)) !== digest(body))
      throw new Error('MEDIA_IMMUTABLE_CONFLICT');
  }
  async privateWrite(key: string, body: Buffer, contentType: string): Promise<void> {
    this.key(key);
    if (
      !key.endsWith('/original') ||
      contentType !== 'application/octet-stream' ||
      body.length > 8 * 1024 * 1024
    )
      throw new Error('MEDIA_ORIGINAL_ONLY');
    await this.writeOnce(key, body, contentType, 'private, no-store');
    await this.verifyPrivate(key);
  }
  async readOriginal(key: string, sha256: string): Promise<Buffer> {
    this.key(key);
    if (!key.endsWith('/original')) throw new Error('MEDIA_ORIGINAL_ONLY');
    await this.verifyPrivate(key);
    const bytes = await this.read(key, 8 * 1024 * 1024);
    if (digest(bytes) !== sha256) throw new Error('MEDIA_ORIGINAL_READBACK');
    return bytes;
  }
  async publish(variant: StoredVariant, body: Buffer): Promise<void> {
    this.key(variant.key);
    if (variant.url !== this.url(variant.key)) throw new Error('MEDIA_URL');
    if (variant.key.endsWith('/original')) throw new Error('MEDIA_ORIGINAL_PRIVATE');
    if (body.length !== variant.bytes || digest(body) !== variant.sha256)
      throw new Error('MEDIA_VARIANT_INVALID');
    // Cloud.ru Evolution has no PutObjectAcl. The reviewed bucket policy grants anonymous
    // GetObject only to the three WebP names; these bytes do not exist until OWNER publication.
    await this.writeOnce(variant.key, body, 'image/webp', PUBLIC_CACHE);
    const r = await this.anonymous(variant.key, true);
    if (
      r.status !== 200 ||
      r.headers.get('content-type') !== 'image/webp' ||
      r.headers.get('cache-control') !== PUBLIC_CACHE ||
      Number(r.headers.get('content-length')) !== variant.bytes ||
      !['*', 'https://mikluha-maklai.ru'].includes(r.headers.get('access-control-allow-origin') ?? '') ||
      r.headers.get('access-control-allow-credentials') === 'true'
    ) {
      await r.body?.cancel();
      throw new Error('MEDIA_PUBLIC_READBACK');
    }
    const reader = r.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (!reader) throw new Error('MEDIA_PUBLIC_READBACK');
    try {
      while (true) {
        const c = await reader.read();
        if (c.done) break;
        size += c.value.length;
        if (size > variant.bytes) throw new Error('MEDIA_PUBLIC_READBACK');
        parts.push(c.value);
      }
    } finally {
      await reader.cancel();
    }
    if (digest(Buffer.concat(parts)) !== variant.sha256) throw new Error('MEDIA_PUBLIC_READBACK');
  }
  async remove(key: string): Promise<void> {
    this.key(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(10_000),
    });
    // Authenticated absence is required: anonymous 403 alone does not prove removal.
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(10_000),
      });
      if (r.Body && 'destroy' in r.Body) r.Body.destroy();
      throw new Error('MEDIA_DELETE_UNCONFIRMED');
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw e;
    }
    await this.denied(key);
  }
}
