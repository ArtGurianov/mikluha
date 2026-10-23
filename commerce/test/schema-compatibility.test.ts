import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { MIGRATIONS_DIR } from '../src/config.js';
import { readMigrations } from '../src/migration-integrity.js';
import { migrate } from '../src/migrate.js';
import { schemaReadiness } from '../src/schema-readiness.js';
import { readiness } from '../src/server.js';
import { fixtureCatalog, freshDb, type TestDb } from './helpers.js';

const SHA = 'a'.repeat(40);
const migrations = readMigrations(MIGRATIONS_DIR);
const nextHead=migrations.length+1;
const build = { schemaHead: migrations.length, migrations, sourceCommit: SHA };
let db: TestDb;
let dir: string;
beforeEach(async () => { db = await freshDb(); dir = mkdtempSync(join(tmpdir(), 'forward-migrations-')); cpSync(MIGRATIONS_DIR, dir, { recursive: true }); });
afterEach(async () => { await db.drop(); rmSync(dir, { recursive: true, force: true }); });

async function forward(runtimeCommits = [SHA], sql = 'ALTER TABLE orders ADD COLUMN future_note text;') {
  const journal = JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8'));
  const entry = { version: journal.length + 1, file: `${String(journal.length + 1).padStart(4, '0')}_forward.sql` };
  const lock = JSON.parse(readFileSync(join(dir, 'migration.lock'), 'utf8'));
  journal.push(entry);
  lock.migrations.push({ ...entry, checksum: createHash('sha256').update(sql).digest('hex'),
    compatibility: { runtimeCommits, evidence: 'schema-compatibility.test.ts: isolated additive fixture only' } });
  writeFileSync(join(dir, entry.file), sql);
  writeFileSync(join(dir, 'journal.json'), JSON.stringify(journal));
  writeFileSync(join(dir, 'migration.lock'), JSON.stringify(lock));
  return migrate(db.owner, dir);
}

const check = () => schemaReadiness(db.pool, build);

test('exact head, compatible ahead, original runtime rollback and independent legal gate', async () => {
  assert.equal((await check()).status, 'READY');
  assert.deepEqual(await forward(), [nextHead]);
  assert.deepEqual(await check(), { status: 'READY', schema: nextHead });
  assert.equal((await schemaReadiness(db.admin, build)).status, 'READY');
  // Roll the application back to its unchanged bundled head, not the database backwards.
  await assert.rejects(migrate(db.owner, MIGRATIONS_DIR), /MIGRATION_CHANGED|MIGRATION_UNKNOWN/);
  assert.deepEqual(await check(), { status: 'READY', schema: nextHead });
  assert.equal((await readiness({ pool: db.pool, catalog: fixtureCatalog([]), ...build, startedAt: new Date(),
    legalAdmission: { verify: async () => { throw new Error('different site SHA'); } } })).reason, 'LEGAL_RELEASE_NOT_ADMITTED');
});

test('database behind image and a mismatched build manifest remain NOT_READY', async () => {
  assert.equal((await schemaReadiness(db.pool, { ...build, schemaHead: nextHead })).reason, 'SCHEMA_NOT_AT_HEAD');
  assert.equal((await schemaReadiness(db.pool, { ...build, migrations: migrations.slice(0, 11) })).reason, 'SCHEMA_BUILD_INVALID');
});

test('every ahead version must approve this exact source SHA; missing or different identity refuses', async () => {
  await forward();
  for (const sourceCommit of [null, 'b'.repeat(40), SHA.slice(0, 7)]) {
    assert.equal((await schemaReadiness(db.pool, { ...build, sourceCommit })).reason, 'SCHEMA_AHEAD_INCOMPATIBLE');
  }
  await forward([], 'CREATE TABLE incompatible_future (id int);');
  assert.equal((await check()).reason, 'SCHEMA_AHEAD_INCOMPATIBLE');
});

test('unknown, missing and altered attestations refuse ahead history', async () => {
  await forward();
  await db.owner.query("UPDATE schema_migration_compatibility SET checksum = repeat('b', 64) WHERE version = $1",[nextHead]);
  assert.equal((await check()).reason, 'SCHEMA_AHEAD_UNKNOWN');
  await assert.rejects(migrate(db.owner, dir), /MIGRATION_COMPATIBILITY_CHANGED/);
  await db.owner.query('DELETE FROM schema_migration_compatibility WHERE version = $1',[nextHead]);
  assert.equal((await check()).reason, 'SCHEMA_AHEAD_UNKNOWN');
});

test('a forged known checksum, filename or missing middle row refuses even at the expected max(version)', async () => {
  await db.owner.query("UPDATE schema_migrations SET checksum = repeat('a', 64) WHERE version = 1");
  assert.equal((await check()).reason, 'SCHEMA_HISTORY_MISMATCH');
  await assert.rejects(migrate(db.owner, MIGRATIONS_DIR), /MIGRATION_CHANGED/);
  await db.owner.query('UPDATE schema_migrations SET checksum = $1, file = $2 WHERE version = 1', [migrations[0]!.checksum, 'renamed.sql']);
  assert.equal((await check()).reason, 'SCHEMA_HISTORY_MISMATCH');
  await db.owner.query('DELETE FROM schema_migrations WHERE version = 1');
  assert.equal((await check()).reason, 'SCHEMA_HISTORY_MISMATCH');
});

test('runtime and admin cannot grant their own forward approvals', async () => {
  for (const pool of [db.pool, db.admin]) {
    await assert.rejects(pool.query("UPDATE schema_migration_compatibility SET runtime_commits = ARRAY[$1]", [SHA]), /permission denied/);
    await assert.rejects(pool.query('DELETE FROM schema_migration_compatibility'), /permission denied/);
    await assert.rejects(pool.query("UPDATE schema_migrations SET checksum = repeat('a', 64)"), /permission denied/);
  }
});

test('failed forward SQL rolls back DDL, history and approval atomically', async () => {
  await assert.rejects(forward([SHA], 'CREATE TABLE must_roll_back (id int); SELECT 1 / 0;'), /division by zero/);
  assert.equal((await db.owner.query("SELECT to_regclass('must_roll_back') AS t")).rows[0].t, null);
  assert.equal((await db.owner.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v, migrations.length);
  assert.equal((await db.owner.query('SELECT max(version) AS v FROM schema_migration_compatibility')).rows[0].v, migrations.length);
  assert.equal((await check()).status, 'READY');
});

test('compatibility classification cannot change after it is applied', async () => {
  await forward();
  const path = join(dir, 'migration.lock');
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  lock.migrations.at(-1).compatibility.runtimeCommits.push('b'.repeat(40));
  writeFileSync(path, JSON.stringify(lock));
  await assert.rejects(migrate(db.owner, dir), /MIGRATION_COMPATIBILITY_CHANGED/);
});


for (const mutation of ['delete', 'file', 'checksum', 'runtime_commits', 'evidence'] as const) {
  test(`known 0012 attestation ${mutation} fails in runtime and migrator at head and ahead`, async () => {
    await forward();
    if (mutation === 'delete') await db.owner.query('DELETE FROM schema_migration_compatibility WHERE version = 12');
    if (mutation === 'file') await db.owner.query("UPDATE schema_migration_compatibility SET file = 'renamed.sql' WHERE version = 12");
    if (mutation === 'checksum') await db.owner.query("UPDATE schema_migration_compatibility SET checksum = repeat('b', 64) WHERE version = 12");
    if (mutation === 'runtime_commits') await db.owner.query('UPDATE schema_migration_compatibility SET runtime_commits = ARRAY[$1] WHERE version = 12', [SHA]);
    if (mutation === 'evidence') await db.owner.query("UPDATE schema_migration_compatibility SET evidence = 'changed' WHERE version = 12");
    for (const pool of [db.pool, db.admin]) {
      assert.equal((await schemaReadiness(pool, build)).reason, 'SCHEMA_ATTESTATION_MISMATCH');
      const newMigrations = readMigrations(dir);
      assert.equal((await schemaReadiness(pool, { ...build, migrations: newMigrations, schemaHead: newMigrations.length })).reason, 'SCHEMA_ATTESTATION_MISMATCH');
    }
    await assert.rejects(migrate(db.owner, dir), /MIGRATION_COMPATIBILITY_CHANGED/);
  });
}

test('missing 0012 attestation is refused on the exact bundled schema', async () => {
  await db.owner.query('DELETE FROM schema_migration_compatibility WHERE version = 12');
  assert.equal((await check()).reason, 'SCHEMA_ATTESTATION_MISMATCH');
});
