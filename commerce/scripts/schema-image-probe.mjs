// Runs via stdin INSIDE the old image. Uses its compiled code, bundled head and identity file.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { readBuildIdentity } from './dist/build-identity.js';
import { readMigrations } from './dist/migration-integrity.js';
import { migrate } from './dist/migrate.js';
import { contractSnapshotIntact } from './dist/contract-snapshot.js';
import { reserve, setSalesOpen, maintain } from './dist/orders.js';
import { issueState, ownsOrder } from './dist/checkout.js';
import { createCommerceServer, readiness } from './dist/server.js';

const identity = await readBuildIdentity('/app/identity/identity.json');
const migrations = readMigrations('./migrations');
assert.equal(migrations.length, 12, 'review this qualification when the real baseline advances');
const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
await owner.connect();
const dir = mkdtempSync(join(tmpdir(), 'schema-proof-'));
let pool, operator, server;
try {
  assert.deepEqual(await migrate(owner, './migrations'), Array.from({ length: 12 }, (_, i) => i + 1));
  await owner.query("CREATE ROLE proof_runtime LOGIN PASSWORD 'test-only' IN ROLE commerce_app");
  await owner.query("CREATE ROLE proof_operator LOGIN PASSWORD 'test-only' IN ROLE commerce_operator");
  const url = new URL(process.env.DATABASE_URL);
  url.username = 'proof_runtime'; url.password = 'test-only';
  pool = new pg.Pool({ connectionString: url.toString() });
  url.username = 'proof_operator'; operator = new pg.Pool({ connectionString: url.toString() });
  const raw = JSON.parse(process.env.QUALIFICATION_CATALOG);
  const catalog = { ...raw, departures: new Map(raw.departures) };
  const deps = { pool, catalog, migrations, schemaHead: migrations.length, sourceCommit: identity.sourceCommit, startedAt: new Date() };
  server = createCommerceServer(deps);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const before = (await owner.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
  cpSync('./migrations', dir, { recursive: true });
  const entry = { version: 13, file: '0013_additive_probe.sql' };
  const sql = 'ALTER TABLE orders ADD COLUMN forward_probe text DEFAULT NULL;';
  const checksum = createHash('sha256').update(sql).digest('hex');
  const journal = JSON.parse(readFileSync(join(dir, 'journal.json'))); journal.push(entry);
  const lock = JSON.parse(readFileSync(join(dir, 'migration.lock')));
  lock.migrations.push({ ...entry, checksum, compatibility: { runtimeCommits: [identity.sourceCommit], evidence: 'isolated old-image additive probe' } });
  writeFileSync(join(dir, entry.file), sql);
  writeFileSync(join(dir, 'journal.json'), JSON.stringify(journal));
  writeFileSync(join(dir, 'migration.lock'), JSON.stringify(lock));
  assert.deepEqual(await migrate(owner, dir), [13]);
  assert.deepEqual((await owner.query('SELECT * FROM schema_migrations WHERE version <= 12 ORDER BY version')).rows, before);
  // No image rebuild or new manifest is supplied to this server after the migration.
  const ready = await (await fetch(`${base}/readyz`)).json();
  assert.equal(ready.status, 'READY'); assert.equal(ready.schema, 13); assert.equal(ready.sourceCommit, identity.sourceCommit);
  const served = await (await fetch(`${base}/identity`)).json();
  assert.equal(served.schemaHead, 12); assert.equal(served.sourceCommit, identity.sourceCommit);
  await setSalesOpen(operator, true, 'isolated-test', 'synthetic fixture only');
  const now = new Date('2027-05-01T00:00:00Z');
  const result = await reserve({ pool, catalog, log: () => {}, now: () => now }, {
    departureSlug: 'proof-departure', contact: { phone: '+79039075547', email: 'proof@example.invalid' },
    passengers: [{ fullName: 'Иван Петров', dateOfBirth: '1990-05-17', citizenship: 'RU', document: { type: 'RU_PASSPORT', series: '3210', number: '654321' } }],
    adultsOnlyConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
    pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
  });
  assert.equal(result.ok, true);
  const contract = (await pool.query('SELECT contract_snapshot, contract_snapshot_sha256 FROM orders WHERE order_ref = $1', [result.orderRef])).rows[0];
  assert.equal(contractSnapshotIntact(contract.contract_snapshot, contract.contract_snapshot_sha256), true);
  const state = await issueState(pool, result.orderRef); assert.ok(state);
  assert.equal(await ownsOrder(pool, result.orderRef, state), true);
  const maintenance = await maintain(pool, () => {}, new Date(now.getTime() + 31 * 60_000));
  assert.equal(maintenance.expired, 1);
  assert.equal((await readiness({ ...deps, sourceCommit: 'b'.repeat(40) })).reason, 'SCHEMA_AHEAD_INCOMPATIBLE');
  assert.equal((await readiness({ ...deps, sourceCommit: null })).reason, 'SCHEMA_AHEAD_INCOMPATIBLE');
  assert.equal((await readiness({ ...deps, schemaHead: 14 })).reason, 'SCHEMA_NOT_AT_HEAD');
  assert.equal((await readiness({ ...deps, legalAdmission: { verify: async () => { throw new Error('different site SHA'); } } })).reason, 'LEGAL_RELEASE_NOT_ADMITTED');
  await assert.rejects(migrate(owner, './migrations'), /MIGRATION_CHANGED|MIGRATION_UNKNOWN/);
  assert.equal((await readiness(deps)).status, 'READY', 'old runtime rollback does not require reversing compatible SQL');
  await owner.query('DELETE FROM schema_migration_compatibility WHERE version = 13');
  assert.equal((await readiness(deps)).reason, 'SCHEMA_AHEAD_UNKNOWN');
  await owner.query('INSERT INTO schema_migration_compatibility VALUES (13, $1, $2, $3, $4)', [entry.file, checksum, [], 'incompatible fixture']);
  assert.equal((await readiness(deps)).reason, 'SCHEMA_AHEAD_INCOMPATIBLE');
  console.log(`SCHEMA_OLD_IMAGE=PASS source=${identity.sourceCommit} bundled=12 database=13 reserve=PASS contract=PASS state=PASS maintenance=PASS negatives=PASS`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await pool?.end(); await operator?.end(); await owner.end(); rmSync(dir, { recursive: true, force: true });
}
