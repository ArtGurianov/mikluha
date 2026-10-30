// The credentialed worker never imports an image decoder or launches untrusted raster code.
import { createHash } from 'node:crypto';
import { request } from 'node:http';
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export class MediaError extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
  ) {
    super(code);
  }
}
export interface VariantBytes {
  profile: number;
  width: number;
  height: number;
  bytes: Buffer;
  sha256: string;
}
export async function transform(source: Buffer): Promise<VariantBytes[]> {
  if (!source.length || source.length > MAX_SOURCE_BYTES) throw new MediaError('MEDIA_SIZE');
  // A Unix socket is the only channel: the decoder container has network_mode:none.
  const socketPath = process.env.MEDIA_DECODER_SOCKET ?? '/run/media-decoder/decode.sock';
  if (!socketPath.startsWith('/') || socketPath.length > 100) throw new Error('MEDIA_DECODER_CONFIG');
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/transform',
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': source.length },
        signal: AbortSignal.timeout(20_000),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new MediaError(
              res.statusCode === 422 ? 'MEDIA_IMAGE_REJECTED' : 'MEDIA_DECODER_UNAVAILABLE',
              res.statusCode === 422 ? 422 : 503,
            ),
          );
          return;
        }
        const data: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 34 * 1024 * 1024) {
            res.destroy();
            reject(new MediaError('MEDIA_DECODER_INVALID', 503));
          } else data.push(chunk);
        });
        res.on('end', () => resolve(data));
        res.on('error', () => reject(new MediaError('MEDIA_DECODER_UNAVAILABLE', 503)));
      },
    );
    req.on('error', () => reject(new MediaError('MEDIA_DECODER_UNAVAILABLE', 503)));
    req.end(source);
  });
  const rows: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (!Array.isArray(rows) || rows.length !== 3) throw new MediaError('MEDIA_DECODER_INVALID', 503);
  return rows.map((row: Record<string, unknown>, index) => {
    const profile = [480, 960, 1600][index]!;
    if (
      row.profile !== profile ||
      !Number.isInteger(row.width) ||
      !Number.isInteger(row.height) ||
      (row.width as number) < 1 ||
      (row.width as number) > profile ||
      (row.height as number) < 1 ||
      (row.height as number) > 8192 ||
      typeof row.data !== 'string' ||
      row.data.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4
    )
      throw new MediaError('MEDIA_DECODER_INVALID', 503);
    const bytes = Buffer.from(row.data, 'base64');
    if (
      !bytes.length ||
      bytes.length > MAX_SOURCE_BYTES ||
      bytes.toString('base64') !== row.data ||
      bytes.subarray(0, 4).toString() !== 'RIFF' ||
      bytes.subarray(8, 12).toString() !== 'WEBP'
    )
      throw new MediaError('MEDIA_DECODER_INVALID', 503);
    return {
      profile,
      width: row.width as number,
      height: row.height as number,
      bytes,
      sha256: digest(bytes),
    };
  });
}
