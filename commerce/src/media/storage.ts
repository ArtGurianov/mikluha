import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  PutObjectAclCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
  publish(variant: StoredVariant): Promise<void>;
  remove(key: string): Promise<void>;
  url(key: string): string;
}
export interface StorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
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
      !config.secretAccessKey
    )
      throw new Error('MEDIA_STORAGE_CONFIG');
    // Cloud.ru browser CORS uses the bucket's domain-style host (legacy policy evidence in
    // lib/cms/asset-source.test.ts). Only the disposable loopback fixture uses path style publicly.
    this.publicBase = ['127.0.0.1', 'localhost'].includes(this.endpoint.hostname)
      ? `${this.endpoint.origin}/${config.bucket}`
      : `https://${config.bucket}.${this.endpoint.host}`;
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
  async privateWrite(key: string, body: Buffer, contentType: string): Promise<void> {
    this.key(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ACL: 'private',
          ContentType: contentType,
          CacheControl: contentType === 'image/webp' ? PUBLIC_CACHE : 'private, no-store',
          IfNoneMatch: '*',
        }),
        { abortSignal: AbortSignal.timeout(10_000) },
      );
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw e;
    }
    if (digest(await this.read(key, body.length)) !== digest(body))
      throw new Error('MEDIA_IMMUTABLE_CONFLICT');
    await this.verifyPrivate(key);
  }
  async publish(variant: StoredVariant): Promise<void> {
    this.key(variant.key);
    if (variant.url !== this.url(variant.key)) throw new Error('MEDIA_URL');
    // Never grant public-read to an original, even if private DB state is corrupted.
    if (variant.key.endsWith('/original')) throw new Error('MEDIA_ORIGINAL_PRIVATE');
    await this.client.send(
      new PutObjectAclCommand({ Bucket: this.config.bucket, Key: variant.key, ACL: 'public-read' }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
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
