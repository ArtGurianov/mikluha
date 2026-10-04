import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseBuildIdentity, readBuildIdentity } from '../src/build-identity.js';

test('build identity accepts only the immutable commerce descriptor shape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mikluha-identity-'));
  const file = join(dir, 'identity.json');
  const expected = { schema: 1 as const, service: 'mikluha-commerce' as const, sourceCommit: 'a'.repeat(40) };
  await writeFile(file, JSON.stringify(expected));
  await chmod(file, 0o444);
  assert.deepEqual(await readBuildIdentity(file), expected);
  assert.throws(() => parseBuildIdentity({ ...expected, sourceCommit: 'main' }), /BUILD_IDENTITY_INVALID/);
});

test('build identity has no environment fallback when its file is absent', async () => {
  const before = process.env.SOURCE_COMMIT;
  process.env.SOURCE_COMMIT = 'b'.repeat(40);
  try { await assert.rejects(readBuildIdentity('/definitely/not/a/build-identity.json'), /BUILD_IDENTITY_UNREADABLE/); }
  finally {
    if (before === undefined) delete process.env.SOURCE_COMMIT;
    else process.env.SOURCE_COMMIT = before;
  }
});
