import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadCatalog } from '../src/catalog.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { migrate, schemaHead } from '../src/migrate.js';
import { readiness } from '../src/server.js';
import { fixtureCatalog, freshDb, type TestDb } from './helpers.js';

let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });

test('migrations apply once; an applied migration that changed is refused', async () => {
  assert.deepEqual(await migrate(db.owner, MIGRATIONS_DIR), []);
  const dir = mkdtempSync(join(tmpdir(), 'commerce-migrations-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  writeFileSync(join(dir, '0001_orders.sql'), '-- rewritten history\n');
  await assert.rejects(migrate(db.owner, dir), /MIGRATION_CHANGED/);
});

test('ready only at exactly this build\'s schema', async () => {
  const deps = { pool: db.pool, catalog: fixtureCatalog([]), sourceCommit: null, startedAt: new Date() };
  assert.equal((await readiness({ ...deps, schemaHead: schemaHead(MIGRATIONS_DIR) })).status, 'READY');
  assert.deepEqual(await readiness({ ...deps, schemaHead: schemaHead(MIGRATIONS_DIR) + 1 }),
    { status: 'NOT_READY', reason: 'SCHEMA_NOT_AT_HEAD', schema: schemaHead(MIGRATIONS_DIR) });
  assert.deepEqual(await readiness({ ...deps, schemaHead: schemaHead(MIGRATIONS_DIR),
    legalAdmission: { verify: async () => { throw new Error('mismatch'); } } }),
  { status: 'NOT_READY', reason: 'LEGAL_RELEASE_NOT_ADMITTED', schema: schemaHead(MIGRATIONS_DIR) });
});

test("the site's own content/ loads, as the image ships it", () => {
  const catalog = loadCatalog(join(MIGRATIONS_DIR, '..', '..', 'content'));
  assert.ok(catalog.departures.size > 0);
  for (const d of catalog.departures.values()) assert.match(d.startsOn, /^\d{4}-\d{2}-\d{2}$/);
});
