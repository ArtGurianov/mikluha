import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_SOURCE_BYTES, MediaError, digest, type VariantBytes } from './transform.js';
export async function decodeIsolated(source: Buffer): Promise<VariantBytes[]> {
  if (!source.length || source.length > MAX_SOURCE_BYTES) throw new MediaError('MEDIA_SIZE');
  const dir = await mkdtemp(join(tmpdir(), 'mk-media-'));
  try {
    await writeFile(join(dir, 'source'), source, { mode: 0o600 });
    const script = fileURLToPath(new URL('../../media/transform.py', import.meta.url));
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.env.MEDIA_PYTHON ?? '/opt/media-python/bin/python', [script, dir], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', OMP_NUM_THREADS: '1', PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let data = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 4096) child.kill('SIGKILL');
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new MediaError('MEDIA_DECODER_UNAVAILABLE', 503));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        code === 0 && !timedOut && data.length <= 4096
          ? resolve(data)
          : reject(new MediaError('MEDIA_IMAGE_REJECTED'));
      });
    });
    const meta = JSON.parse(output) as { profile: number; width: number; height: number }[];
    if (!Array.isArray(meta) || meta.length !== 3) throw new MediaError('MEDIA_IMAGE_REJECTED');
    const variants: VariantBytes[] = [];
    for (const [i, profile] of [480, 960, 1600].entries()) {
      const item = meta[i];
      if (
        !item ||
        item.profile !== profile ||
        !Number.isInteger(item.width) ||
        !Number.isInteger(item.height) ||
        item.width < 1 ||
        item.width > profile ||
        item.height < 1 ||
        item.height > 8192
      )
        throw new MediaError('MEDIA_IMAGE_REJECTED');
      const bytes = await readFile(join(dir, `${profile}.webp`));
      if (
        bytes.length > 8 * 1024 * 1024 ||
        bytes.subarray(0, 4).toString() !== 'RIFF' ||
        bytes.subarray(8, 12).toString() !== 'WEBP'
      )
        throw new MediaError('MEDIA_IMAGE_REJECTED');
      variants.push({ ...item, bytes, sha256: digest(bytes) });
    }
    return variants;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
