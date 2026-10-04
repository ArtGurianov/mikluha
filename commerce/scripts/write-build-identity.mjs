import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const [target, sourceCommit] = process.argv.slice(2);
if (!target || !/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) throw new Error('BUILD_SOURCE_COMMIT_INVALID');
await mkdir(dirname(target), { recursive: true, mode: 0o555 });
await writeFile(target, `${JSON.stringify({ schema: 1, service: 'mikluha-commerce', sourceCommit })}\n`, { mode: 0o444 });
