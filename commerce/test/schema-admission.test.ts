import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { AfterResponse } from '../src/arrival.js';
import { createAdminServer } from '../src/admin/api.js';
import { processEmailOutbox } from '../src/email.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { readMigrations } from '../src/migration-integrity.js';
import { maintain, reserve, setSalesOpen } from '../src/orders.js';
import { SchemaAdmission, schemaWorker } from '../src/schema-admission.js';
import { schemaReadiness } from '../src/schema-readiness.js';
import { createCommerceServer } from '../src/server.js';
import { fixtureCatalog, freshDb, tourist, type TestDb } from './helpers.js';

const build = { schemaHead: 12, migrations: readMigrations(MIGRATIONS_DIR), sourceCommit: 'a'.repeat(40) };
let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
const listen = async (server: Server) => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
};
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); };
async function call(port: number, path: string, method = 'GET') {
  return new Promise<number>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'admin.example.invalid', origin: 'https://admin.example.invalid', 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject); req.end(method === 'GET' ? undefined : '{}');
  });
}

test('NOT_READY refuses direct commerce/admin requests and workers without DB or provider side effects; admission recovers', async () => {
  const catalog = fixtureCatalog([{ slug: 'schema-gate', startsOn: '2027-06-01', endsOn: '2027-06-04', capacity: 12 }]);
  const now = new Date('2027-05-01T00:00:00Z');
  await setSalesOpen(db.operator, true, 'test', 'isolated test');
  const booking = { departureSlug: 'schema-gate', contact: { phone: '+79039075547', email: 'proof@example.invalid' }, passengers: [tourist(1)],
    adultsOnlyConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
    pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash };
  const booked = await reserve({ pool: db.pool, catalog, log: () => {}, now: () => now }, booking);
  assert.ok(booked.ok);
  await db.owner.query(`INSERT INTO email_outbox (order_id, type, recipient_email, access_token, idempotency_key, state, next_attempt_at, created_at)
    SELECT id, 'BOOKING_CONFIRMATION', 'proof@example.invalid', $2, 'schema-proof', 'PENDING', $3, $3 FROM orders WHERE order_ref = $1`,
  [booked.orderRef, 'a'.repeat(43), now]);
  const before = (await db.owner.query('SELECT * FROM orders ORDER BY id')).rows;
  const outbox = (await db.owner.query('SELECT * FROM email_outbox')).rows;
  const admission = new SchemaAdmission(() => schemaReadiness(db.pool, build));
  let routes = 0, remoteCalls = 0;
  const commerce = createCommerceServer({ pool: db.pool, catalog, ...build, admission, startedAt: now }, async (_req, res) => {
    routes++;
    const r = await reserve({ pool: db.pool, catalog, log: () => {}, now: () => now }, booking);
    assert.ok(r.ok); res.end('ok'); return true;
  });
  const admin = createAdminServer({ pool: db.admin, publisherPool: db.publisher, ...build, startedAt: now,
    origin: 'https://admin.example.invalid', totpKey: Buffer.alloc(32, 1), auditKeys: { id: 'test', key: Buffer.alloc(32, 2) }, log: () => {} });
  const port = await listen(commerce), adminPort = await listen(admin);
  const worker = schemaWorker(admission, [
    () => maintain(db.pool, () => {}, new Date(now.getTime() + 31 * 60_000)),
    () => processEmailOutbox(db.pool, { send: async () => { remoteCalls++; return { kind: 'ACCEPTED', jobId: 'test-job' }; } }, () => {}, () => now),
  ], e => { throw e; });
  const after = new AfterResponse(admission);
  const attestation = (await db.owner.query('SELECT * FROM schema_migration_compatibility WHERE version = 12')).rows[0];
  try {
    // A live container previously ready at 12 must stop dispatching after history is damaged.
    assert.equal(await call(port, '/readyz'), 200);
    await db.owner.query('DELETE FROM schema_migration_compatibility WHERE version = 12');
    const refused = async () => {
      assert.equal(await call(port, '/readyz'), 503);
      assert.equal(await call(port, '/orders', 'POST'), 503);
      assert.equal(await call(port, '/order-status'), 503); // GETs can mutate sessions/reconciliation.
      assert.equal(await call(adminPort, '/api/auth/login', 'POST'), 503);
      assert.equal(await call(adminPort, '/api/auth/session'), 503);
      assert.equal(await call(port, '/healthz'), 200);
      assert.equal(await call(adminPort, '/identity'), 200);
      await worker.tick(); await after.run(async () => { remoteCalls++; });
      assert.equal(routes, 0); assert.equal(remoteCalls, 0);
      assert.deepEqual((await db.owner.query('SELECT * FROM orders ORDER BY id')).rows, before);
      assert.deepEqual((await db.owner.query('SELECT * FROM email_outbox')).rows, outbox);
      assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM admin_login_throttle')).rows[0].n, 0);
    };
    await refused();
    await db.owner.query('INSERT INTO schema_migration_compatibility VALUES ($1,$2,$3,$4,$5)',
      [attestation.version, attestation.file, attestation.checksum, attestation.runtime_commits, attestation.evidence]);
    // Owner-controlled test fixture: unknown then explicitly incompatible ahead history.
    await db.owner.query("INSERT INTO schema_migrations (version, file, checksum) VALUES (13, '0013_incompatible.sql', repeat('b', 64))");
    await refused();
    await db.owner.query("INSERT INTO schema_migration_compatibility VALUES (13, '0013_incompatible.sql', repeat('b',64), '{}', 'incompatible test fixture')");
    await refused();
    // Restore the sabotage fixture only; production rollback never deletes migration history.
    await db.owner.query('DELETE FROM schema_migration_compatibility WHERE version = 13');
    await db.owner.query('DELETE FROM schema_migrations WHERE version = 13');
    assert.equal(await call(port, '/orders', 'POST'), 200);
    await worker.tick();
    assert.equal(routes, 1); assert.equal(remoteCalls, 1);
    assert.equal((await db.owner.query('SELECT status FROM orders WHERE order_ref = $1', [booked.orderRef])).rows[0].status, 'EXPIRED');
  } finally {
    await close(commerce); await close(admin); await worker.drain(); await after.drain();
  }
});

test('worker rechecks between steps and skips work after readiness changes', async () => {
  const admission = new SchemaAdmission(() => schemaReadiness(db.pool, build));
  const old = (await db.owner.query('SELECT evidence FROM schema_migration_compatibility WHERE version = 12')).rows[0].evidence;
  let next = 0;
  const worker = schemaWorker(admission, [
    async () => { await db.owner.query("UPDATE schema_migration_compatibility SET evidence = 'changed' WHERE version = 12"); },
    async () => { next++; },
  ], e => { throw e; });
  try { await worker.tick(); assert.equal(next, 0); }
  finally { await db.owner.query('UPDATE schema_migration_compatibility SET evidence = $1 WHERE version = 12', [old]); }
});

test('drain waits for admitted external work, refuses a pending check and stops subsequent worker steps', async () => {
  const started = defer(), release = defer();
  const admission = new SchemaAdmission(async () => ({ status: 'READY' }));
  let steps = 0;
  const worker = schemaWorker(admission, [async () => { steps++; started.resolve(); await release.promise; }, async () => { steps++; }], e => { throw e; });
  const tick = worker.tick(); await started.promise;
  let drained = false;
  const draining = admission.drain().then(() => { drained = true; });
  worker.stop();
  assert.equal((await admission.run(async () => { steps++; })).reason, 'RUNTIME_DRAINING');
  assert.equal(drained, false);
  release.resolve(); await tick; await draining; await worker.drain();
  assert.equal(steps, 1);
  const checking = defer();
  const racing = new SchemaAdmission(async () => { await checking.promise; return { status: 'READY' }; });
  const pending = racing.run(async () => { steps++; });
  const stopped = racing.drain(); checking.resolve(); await stopped;
  assert.equal((await pending).reason, 'RUNTIME_DRAINING'); assert.equal(steps, 1);
});

test('commerce readyz reads schema once, preserves independent legal admission and refuses draining', async () => {
  let queries = 0, legalChecks = 0, legalReady = true;
  const pool = new Proxy(db.pool, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === 'query') return (...args: unknown[]) => { queries++; return value.apply(target, args); };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const admission = new SchemaAdmission(() => schemaReadiness(pool, build));
  const server = createCommerceServer({ pool, admission, ...build, catalog: fixtureCatalog([]), startedAt: new Date(),
    legalAdmission: { verify: async () => { legalChecks++; if (!legalReady) throw new Error('legal mismatch'); } } });
  const port = await listen(server);
  try {
    assert.equal(await call(port, '/readyz'), 200);
    assert.equal(queries, 1); assert.equal(legalChecks, 1);
    legalReady = false;
    assert.equal(await call(port, '/readyz'), 503);
    assert.equal(queries, 2); assert.equal(legalChecks, 2);
    await admission.drain();
    assert.equal(await call(port, '/readyz'), 503);
    assert.equal(queries, 2); assert.equal(legalChecks, 2);
  } finally { await close(server); }
});

test('HTTP request admitted before shutdown can register its arrival before returning', async () => {
  const { Arrivals, newContextId } = await import('../src/arrival.js');
  const admission = new SchemaAdmission(() => schemaReadiness(db.pool, build));
  const after = new AfterResponse(admission);
  let sends = 0;
  const arrivals = new Arrivals({ after, storefrontOrigin: 'https://book.example.invalid', log: () => {},
    refref: { claimArrival: async () => { sends++; return { kind: 'ANSWERED', status: 201, body: {
      claimId: 'test', browserContextId: 'test', storefrontOrigin: 'https://book.example.invalid',
      claimedAt: '2026-10-23T00:00:00Z', eligibleUntil: '2026-11-22T00:00:00Z',
    } }; } } });
  const entered = defer(), release = defer(), id = newContextId();
  const server = createCommerceServer({ pool: db.pool, admission, ...build, catalog: fixtureCatalog([]), startedAt: new Date() }, async (_req, res) => {
    entered.resolve(); await release.promise;
    arrivals.capture(id, `ar1.${'a'.repeat(43)}`); arrivals.afterResponse(res, id);
    res.end('ok'); return true;
  });
  const port = await listen(server);
  const request = call(port, '/arrive'); await entered.promise;
  after.stop(); const admitted = admission.drain();
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  try {
    release.resolve(); assert.equal(await request, 200);
    await Promise.all([admitted, closed]); await after.drain();
    assert.equal(sends, 1); assert.equal(arrivals.hasPending(id), false);
  } finally { release.resolve(); await request; await close(server); }
});
