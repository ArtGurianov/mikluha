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
import { createRetiredCheckoutHandler } from './dist/retired-checkout.js';
import { reserveNativePurchase } from './dist/purchases.js';
import { SchemaAdmission, schemaWorker } from './dist/schema-admission.js';
import { schemaReadiness } from './dist/schema-readiness.js';
import { createCommerceServer, readiness, routes } from './dist/server.js';

const identity = await readBuildIdentity('/app/identity/identity.json');
assert.equal(identity.sourceCommit, process.env.QUALIFICATION_SOURCE_COMMIT, 'image must identify the declared exact HEAD');
const migrations = readMigrations('./migrations');
const bundledHead=19, forwardHead=20;
assert.equal(migrations.length, bundledHead, 'review this qualification when the real baseline advances');
const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
await owner.connect();
const dir = mkdtempSync(join(tmpdir(), 'schema-proof-'));
let pool, operator, server;
try {
  assert.deepEqual(await migrate(owner, './migrations'), Array.from({ length: bundledHead }, (_, i) => i + 1));
  assert.equal((await owner.query("SELECT has_table_privilege('commerce_app','public_media','SELECT') AS allowed")).rows[0].allowed,true);
  assert.equal((await owner.query("SELECT has_table_privilege('commerce_app','media_asset','SELECT') AS allowed")).rows[0].allowed,false);
  await owner.query("CREATE ROLE proof_runtime LOGIN PASSWORD 'test-only' IN ROLE commerce_app");
  await owner.query("CREATE ROLE proof_operator LOGIN PASSWORD 'test-only' IN ROLE commerce_operator");
  const url = new URL(process.env.DATABASE_URL);
  url.username = 'proof_runtime'; url.password = 'test-only';
  pool = new pg.Pool({ connectionString: url.toString() });
  url.username = 'proof_operator'; operator = new pg.Pool({ connectionString: url.toString() });
  const raw = JSON.parse(process.env.QUALIFICATION_CATALOG);
  const catalog = { ...raw, departures: new Map(raw.departures) };
  // Runtime reserve reads only published PostgreSQL content. Seed synthetic facts via owner SQL.
  for (const d of catalog.departures.values()) {
    const tour=(await owner.query('SELECT fn_create_tour($1,$2) AS id',[d.tourSlug,'isolated-proof'])).rows[0].id;
    await owner.query('SELECT fn_save_tour_draft($1,0,$2,$3)',[tour,{slug:d.tourSlug,title:d.tourTitle,contract:null,content:{}},'isolated-proof']);
    await owner.query('SELECT fn_publish_tour($1,1,0,$2)',[tour,'isolated-proof']);
    await owner.query('UPDATE tour SET is_listed=true WHERE id=$1',[tour]);
    const id=(await owner.query('SELECT fn_create_departure($1,$2,$3) AS id',[tour,d.slug,'isolated-proof'])).rows[0].id;
    const dc=d.contract.departure;
    const contract={tour:d.contract.tour,departure:Object.fromEntries(Object.entries(dc).filter(([k])=>!['departureTime','returnTime'].includes(k)))};
    await owner.query('SELECT fn_save_departure_draft($1,1,$2,$3)',[id,{slug:d.slug,startsOn:d.startsOn,endsOn:d.endsOn,
      departureTime:dc.departureTime,returnTime:dc.returnTime,timezone:catalog.timezone,priceKopecks:d.priceKopecks,contract,content:{}},'isolated-proof']);
    await owner.query('SELECT fn_publish_departure($1,2,0,$2)',[id,'isolated-proof']);
    await owner.query('UPDATE departure SET capacity=$2,booking_status=$3,is_listed=true,is_demo=false WHERE id=$1',[id,d.capacity,d.bookingStatus]);
  }
  const deps = { pool, catalog, migrations, schemaHead: migrations.length, sourceCommit: identity.sourceCommit, startedAt: new Date() };
  const admission = new SchemaAdmission(() => schemaReadiness(pool, deps));
  let routeCalls = 0, workerCalls = 0;
  server = createCommerceServer({ ...deps, admission }, routes(createRetiredCheckoutHandler('https://site.example.invalid'), async (_req, res) => {
    routeCalls++; res.end('operation'); return true;
  }));
  const worker = schemaWorker(admission, [async () => { workerCalls++; }], error => { throw error; });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.equal((await fetch(`${base}/operation`, { method: 'POST' })).status, 200);
  await worker.tick(); assert.equal(workerCalls, 1);
  const before = (await owner.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
  cpSync('./migrations', dir, { recursive: true });
  const entry = { version: forwardHead, file: '0020_additive_probe.sql' };
  const sql = 'ALTER TABLE orders ADD COLUMN forward_probe text DEFAULT NULL;';
  const checksum = createHash('sha256').update(sql).digest('hex');
  const journal = JSON.parse(readFileSync(join(dir, 'journal.json'))); journal.push(entry);
  const lock = JSON.parse(readFileSync(join(dir, 'migration.lock')));
  lock.migrations.push({ ...entry, checksum, compatibility: { runtimeCommits: [identity.sourceCommit], evidence: 'isolated old-image additive probe' } });
  writeFileSync(join(dir, entry.file), sql);
  writeFileSync(join(dir, 'journal.json'), JSON.stringify(journal));
  writeFileSync(join(dir, 'migration.lock'), JSON.stringify(lock));
  assert.deepEqual(await migrate(owner, dir), [forwardHead]);
  assert.deepEqual((await owner.query('SELECT * FROM schema_migrations WHERE version <= $1 ORDER BY version',[bundledHead])).rows, before);
  // No image rebuild or new manifest is supplied to this server after the migration.
  const ready = await (await fetch(`${base}/readyz`)).json();
  assert.equal(ready.status, 'READY'); assert.equal(ready.schema, forwardHead); assert.equal(ready.sourceCommit, identity.sourceCommit);
  assert.equal((await fetch(`${base}/operation`, { method: 'POST' })).status, 200);
  await worker.tick(); assert.equal(workerCalls, 2);
  const served = await (await fetch(`${base}/identity`)).json();
  assert.equal(served.schemaHead, bundledHead); assert.equal(served.sourceCommit, identity.sourceCommit);
  await setSalesOpen(operator, true, 'isolated-test', 'synthetic fixture only');
  const now = new Date('2027-05-01T00:00:00Z');
  const booking = {
    departureSlug: 'proof-departure', contact: { phone: '+79039075547', email: 'proof@example.invalid' },
    passengers: [{ fullName: 'Иван Петров', dateOfBirth: '1990-05-17', citizenship: 'RU', document: { type: 'RU_PASSPORT', series: '3210', number: '654321' } }],
    adultsOnlyConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
    pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
  };
  const result = await reserve({ pool, catalog, log: () => {}, now: () => now }, booking);
  assert.equal(result.ok, true);
  // The bundled purchase path also runs unchanged on the forward schema.
  const purchase = await reserveNativePurchase({ pool, catalog, log: () => {}, now: () => now }, booking);
  assert.equal(purchase.ok, true); assert.match(purchase.purchaseRef, /^mp-[0-9a-f]{20}$/);
  assert.equal((await pool.query('SELECT lifecycle_profile FROM purchase_current WHERE purchase_ref = $1', [purchase.purchaseRef])).rows[0].lifecycle_profile, 'NATIVE_NO_REFERRAL');
  const contract = (await pool.query('SELECT contract_snapshot, contract_snapshot_sha256 FROM orders WHERE order_ref = $1', [result.orderRef])).rows[0];
  assert.equal(contractSnapshotIntact(contract.contract_snapshot, contract.contract_snapshot_sha256), true);
  for (const [method, path] of [['GET', '/book'], ['POST', '/orders'], ['POST', '/orders/old/pay'], ['GET', '/arrive']]) {
    const retired = await fetch(base + path, { method, redirect: 'manual' });
    assert.equal(retired.status, 410);
    assert.equal(retired.headers.get('set-cookie'), null);
    assert.equal(retired.headers.get('location'), null);
    await retired.text();
  }
  const maintenance = await maintain(pool, () => {}, new Date(now.getTime() + 31 * 60_000));
  assert.equal(maintenance.expired, 2);
  assert.equal((await readiness({ ...deps, sourceCommit: 'b'.repeat(40) })).reason, 'SCHEMA_AHEAD_INCOMPATIBLE');
  assert.equal((await readiness({ ...deps, sourceCommit: null })).reason, 'SCHEMA_AHEAD_INCOMPATIBLE');
  assert.equal((await readiness({ ...deps, schemaHead: forwardHead+1 })).reason, 'SCHEMA_NOT_AT_HEAD');
  assert.equal((await readiness({ ...deps, legalAdmission: { verify: async () => { throw new Error('different site SHA'); } } })).reason, 'LEGAL_RELEASE_NOT_ADMITTED');
  await assert.rejects(migrate(owner, './migrations'), /MIGRATION_CHANGED|MIGRATION_UNKNOWN/);
  assert.equal((await readiness(deps)).status, 'READY', 'old runtime rollback does not require reversing compatible SQL');
  await owner.query('DELETE FROM schema_migration_compatibility WHERE version = $1',[forwardHead]);
  assert.equal((await readiness(deps)).reason, 'SCHEMA_AHEAD_UNKNOWN');
  assert.equal((await fetch(`${base}/operation`, { method: 'POST' })).status, 503);
  await worker.tick(); assert.equal(routeCalls, 2); assert.equal(workerCalls, 2);
  await owner.query('INSERT INTO schema_migration_compatibility VALUES ($1, $2, $3, $4, $5)', [forwardHead, entry.file, checksum, [], 'incompatible fixture']);
  assert.equal((await readiness(deps)).reason, 'SCHEMA_AHEAD_INCOMPATIBLE');
  assert.equal((await fetch(`${base}/operation`, { method: 'POST' })).status, 503);
  await worker.tick(); assert.equal(routeCalls, 2); assert.equal(workerCalls, 2);
  await owner.query('DELETE FROM schema_migration_compatibility WHERE version = 12');
  assert.equal((await readiness(deps)).reason, 'SCHEMA_ATTESTATION_MISMATCH');
  await admission.drain(); await worker.drain();
  console.log(`SCHEMA_OLD_IMAGE=PASS source=${identity.sourceCommit} bundled=${bundledHead} database=${forwardHead} reserve=PASS purchase=PASS contract=PASS retired=PASS maintenance=PASS negatives=PASS`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await pool?.end(); await operator?.end(); await owner.end(); rmSync(dir, { recursive: true, force: true });
}
