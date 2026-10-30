import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createDeparture, createTour, publishDeparture, publishTour, saveDepartureDraft, saveTourDraft, type Document } from '../src/editorial.js';
import { reserve, setSalesOpen } from '../src/orders.js';
import { fixtureCatalog, freshDb, tourist, type TestDb } from './helpers.js';
let db: TestDb;
const catalog = fixtureCatalog([{ slug: 'fixture', startsOn: '2028-07-01', endsOn: '2028-07-04' }]);
const unique = () => randomBytes(5).toString('hex');
before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });
async function departure() {
  const slug = `control-${unique()}`, ts = `tour-${unique()}`;
  const tour = await createTour(db.admin, ts, 'editor');
  await saveTourDraft(db.admin, tour, 0, { slug: ts, title: 'Алтай', isListed: true, contract: null, content: {} }, 'editor');
  await publishTour(db.publisher, tour, { draftRevision: 1, publishedVersion: 0 }, 'owner');
  const id = await createDeparture(db.admin, tour, slug, 'editor');
  const { tour: t, departure: { departureTime: _d, returnTime: _r, ...facts } } = catalog.departures.get('fixture')!.contract!;
  const document = { slug, startsOn: '2028-07-01', endsOn: '2028-07-04', departureTime: '06:00', returnTime: '21:00', timezone: 'Asia/Krasnoyarsk', priceKopecks: 3_000_000, contract: { tour: t, departure: facts }, content: {} } as unknown as Document;
  await saveDepartureDraft(db.admin, id, 1, document, 'editor');
  await publishDeparture(db.publisher, id, { draftRevision: 2, publishedVersion: 0 }, 'owner');
  return { id, slug, tour, document };
}
const row = async (id: string) => (await db.admin.query('SELECT * FROM departure WHERE id=$1', [id])).rows[0];
async function control(id: string, status: string | null, capacity: number | null = null, listed: boolean | null = null, expected?: number) {
  return (await db.publisher.query('SELECT fn_admin_departure_controls($1,$2,$3,$4,$5,$6) AS r', [id, expected ?? (await row(id)).control_version, status, capacity, listed, 'admin:owner'])).rows[0].r;
}
const pause = async () => (await db.publisher.query("SELECT fn_admin_pause_all('admin:owner') AS r")).rows[0].r;
const resume = async (id: string) => (await db.publisher.query("SELECT fn_admin_resume_batch($1,'admin:owner') AS r", [id])).rows[0].r;
const global = (open: boolean) => setSalesOpen(db.operator, open, 'operator', 'synthetic controls test');
async function open(id: string) { await global(true); await control(id, 'OPEN', 10, true); }

test('CLOSED defaults; publisher-only commands have no global/cancellation authority', async () => {
  assert.equal((await db.pool.query('SELECT open FROM sales_switch')).rows[0].open, false);
  const d = await departure(); assert.equal((await row(d.id)).booking_status, 'CLOSED'); assert.equal((await row(d.id)).is_listed, false);
  for (const pool of [db.admin, db.pool, db.operator]) for (const sql of ["SELECT fn_admin_pause_all('owner')", `SELECT fn_admin_departure_controls('${d.id}',0,'OPEN',10,true,'owner')`, "SELECT fn_admin_resume_batch(gen_random_uuid(),'owner')"]) await assert.rejects(pool.query(sql), /permission denied/);
  await assert.rejects(db.publisher.query("SELECT fn_set_sales_open(true,'owner','forged')"), /permission denied/);
  await assert.rejects(control(d.id, 'CANCELLED'), /DEPARTURE_STATUS_INVALID/);
  await assert.rejects(control(d.id, 'OPEN', 10, true), /GLOBAL_OPERATOR_STOP/);
  await assert.rejects(db.admin.query('UPDATE departure SET capacity=100'), /permission denied/);
});
test('OPEN admission, stale controls, hide requires close, cancelled is irreversible', async () => {
  const d = await departure(); await global(true);
  await assert.rejects(control(d.id, 'OPEN'), /DEPARTURE_NOT_PUBLIC/);
  await assert.rejects(control(d.id, 'OPEN', null, true), /DEPARTURE_INCOMPLETE/);
  const old = (await row(d.id)).control_version; await control(d.id, 'OPEN', 10, true);
  await assert.rejects(control(d.id, 'CLOSED', null, null, old), /DEPARTURE_CONTROL_CONFLICT/);
  await assert.rejects(control(d.id, null, null, false), /DEPARTURE_CLOSE_BEFORE_HIDE/);
  await control(d.id, 'CLOSED', null, false); await global(false);
  await assert.rejects(control(d.id, 'OPEN'), /GLOBAL_OPERATOR_STOP/);
  await db.owner.query("UPDATE departure SET booking_status='CANCELLED' WHERE id=$1", [d.id]);
  await assert.rejects(control(d.id, 'CLOSED'), /DEPARTURE_CANCELLED/);
});
test('batch restore excludes same-value manual CLOSE, hidden, cancelled and new rows', async () => {
  const a = await departure(), b = await departure(), c = await departure(), d = await departure(), e = await departure();
  for (const x of [a,b,c,d]) await open(x.id);
  const batch = await pause(); assert.ok(batch.closed >= 4);
  await control(b.id, 'CLOSED'); await control(c.id, null, null, false);
  await db.owner.query("UPDATE departure SET booking_status='CANCELLED' WHERE id=$1", [d.id]);
  await control(e.id, null, 10, true); const result = await resume(batch.batchId);
  assert.equal((await row(a.id)).booking_status, 'OPEN');
  for (const x of [b,c,e]) assert.equal((await row(x.id)).booking_status, 'CLOSED');
  assert.equal((await row(d.id)).booking_status, 'CANCELLED'); assert.ok(result.skipped.length >= 3);
  assert.equal((await resume(batch.batchId)).opened, 0);
  await assert.rejects(db.admin.query('DELETE FROM departure_control_batch_member'), /permission denied/);
  await assert.rejects(db.owner.query('DELETE FROM departure_control_batch'), /EDITORIAL_HISTORY_IMMUTABLE/);
});
test('global stop and independent batches cannot revive superseded intent', async () => {
  const d = await departure(); await open(d.id); const first = await pause();
  await global(false); await assert.rejects(resume(first.batchId), /GLOBAL_OPERATOR_STOP/);
  await global(true); await control(d.id, 'OPEN'); const second = await pause();
  await resume(first.batchId); assert.equal((await row(d.id)).booking_status, 'CLOSED');
  await resume(second.batchId); assert.equal((await row(d.id)).booking_status, 'OPEN');
});
test('last-seat race against capacity uses canonical taken seats, preserving HELD uncertainty', async () => {
  const d = await departure(); await open(d.id); await control(d.id, null, 2);
  const req = (n: number) => ({ departureSlug: d.slug, contact: { phone: '+79039075547', email: `test${n}@example.ru` }, passengers: [tourist(n)], adultsOnlyConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash, pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash });
  const deps = { pool: db.pool, catalog, log: () => undefined, allowDemo: false, now: () => new Date() };
  assert.ok((await reserve(deps, req(1))).ok);
  const results = await Promise.allSettled([reserve(deps, req(2)), control(d.id, null, 1)]);
  const capacity = (await row(d.id)).capacity;
  const taken = Number((await db.pool.query('SELECT fn_departure_taken_seats($1,clock_timestamp()) AS n',[d.slug])).rows[0].n);
  assert.ok(taken <= capacity); assert.ok(results.some(r => r.status === 'fulfilled'));
  if (taken === 2) await assert.rejects(control(d.id, null, 1), /CAPACITY_BELOW_TAKEN/);
  await db.owner.query("UPDATE orders SET status='HELD', snapshot='{}', snapshot_hash='refref-jcs-1:0000000000000000000000000000000000000000000000000000000000000000', payment_pending_since=now(), hold_reason='TEST_UNKNOWN' WHERE departure_slug=$1", [d.slug]);
  assert.equal(Number((await db.pool.query('SELECT fn_departure_taken_seats($1,clock_timestamp()) AS n',[d.slug])).rows[0].n), taken);
});
test('batch atomic visibility and shared barrier block a concurrent OPEN until commit', async () => {
  const d = await departure(); await open(d.id); const client = await db.publisher.connect();
  try {
    await client.query('BEGIN'); await client.query("SELECT fn_admin_pause_all('admin:owner')");
    assert.equal((await row(d.id)).booking_status, 'OPEN');
    const opening = control(d.id, 'OPEN');
    // Attach the rejection immediately; after the commit its expected version will be stale.
    const rejected = assert.rejects(opening, /DEPARTURE_CONTROL_CONFLICT/);
    for (let i=0; i<200; i++) {
      const n = Number((await db.owner.query("SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n);
      if (n > 0) break; if (i===199) assert.fail('OPEN did not wait on the batch'); await new Promise(r => setTimeout(r, 5));
    }
    await client.query('COMMIT'); await rejected; assert.equal((await row(d.id)).booking_status, 'CLOSED');
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('a failure in one member rolls back the entire pause batch and its receipt', async () => {
  const a=await departure(),b=await departure();await open(a.id);await open(b.id);
  const ids=(await db.owner.query("SELECT id FROM departure WHERE booking_status='OPEN' ORDER BY id")).rows.map(r=>r.id);
  const count=Number((await db.owner.query('SELECT count(*) AS n FROM departure_control_batch')).rows[0].n);
  await db.owner.query(`CREATE FUNCTION fn_test_refuse_close() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF NEW.id = '${ids.at(-1)}' AND NEW.booking_status = 'CLOSED' THEN RAISE EXCEPTION 'SYNTHETIC_BATCH_FAILURE'; END IF; RETURN NEW; END $f$`);
  await db.owner.query('CREATE TRIGGER trg_test_refuse_close BEFORE UPDATE OF booking_status ON departure FOR EACH ROW EXECUTE FUNCTION fn_test_refuse_close()');
  try {
    await assert.rejects(pause(),/SYNTHETIC_BATCH_FAILURE/);
    assert.deepEqual((await db.owner.query("SELECT id FROM departure WHERE booking_status='OPEN' ORDER BY id")).rows.map(r=>r.id),ids);
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM departure_control_batch')).rows[0].n),count);
  } finally {await db.owner.query('DROP TRIGGER trg_test_refuse_close ON departure');await db.owner.query('DROP FUNCTION fn_test_refuse_close()');}
});
