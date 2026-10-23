// Migration 0008 (ADR v2.3 §2–§3, ART-357), proved with direct database credentials: published
// identity, editorial revisions with expected versions, the date lock, and the order's immutable
// contract snapshot. The owner login stands for "direct DB credentials": triggers bind it too.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';

import pg from 'pg';

import type { Bookable, Catalog } from '../src/catalog.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { buildContractSnapshot, contractSnapshotHash, contractSnapshotIntact } from '../src/contract-snapshot.js';
import { schemaHead } from '../src/migrate.js';
import { reserve, setSalesOpen, type BookingRequest } from '../src/orders.js';
import { seedCatalog, fixtureCatalog, freshDb, tourist, type TestDb } from './helpers.js';

const run = promisify(execFile);
const NOW = new Date('2026-10-04T06:00:00Z');

let db: TestDb;
let catalog: Catalog;

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: 'altai-legacy', startsOn: '2027-07-01', endsOn: '2027-07-04' }]);
});
after(async () => { await db.drop(); });

const uniq = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex')}`;

/** The fixture contract, in the shape a departure stores it: the schedule lives in columns only. */
function storedContract(): Record<string, unknown> {
  const { tour, departure } = catalog.departures.get('altai-legacy')!.contract!;
  const { departureTime: _d, returnTime: _r, ...rest } = departure;
  return { tour, departure: rest };
}

const tourDoc = (slug: string, over: Record<string, unknown> = {}) =>
  ({ slug, title: 'Алтай', contract: null, content: { summary: 'Тур на Алтай' }, ...over });

const departureDoc = (slug: string, over: Record<string, unknown> = {}) => ({
  slug, startsOn: '2027-06-01', endsOn: '2027-06-04', departureTime: '06:00', returnTime: '21:00',
  timezone: 'Asia/Krasnoyarsk', priceKopecks: 3_400_000, contract: storedContract(),
  content: { description: 'Четыре дня на озере' }, ...over,
});

async function publishedTour(): Promise<{ id: string; slug: string }> {
  const slug = uniq('tour');
  const id = (await db.admin.query<{ id: string }>('SELECT fn_create_tour($1, $2) AS id', [slug, 'editor'])).rows[0]!.id;
  await db.admin.query('SELECT fn_save_tour_draft($1, 0, $2, $3)', [id, tourDoc(slug), 'editor']);
  await db.publisher.query('SELECT fn_publish_tour($1, 1, 0, $2)', [id, 'owner']);
  return { id, slug };
}

interface Dep { id: string; slug: string; draft: number; version: number }

async function newDeparture(publish = true, over: Record<string, unknown> = {}): Promise<Dep> {
  const tour = await publishedTour();
  const slug = uniq('altai');
  // Creation seeds draft revision 1 from the tour's template (migration 0009); the editor saves revision 2.
  const id = (await db.admin.query<{ id: string }>('SELECT fn_create_departure($1, $2, $3) AS id', [tour.id, slug, 'editor'])).rows[0]!.id;
  await db.admin.query('SELECT fn_save_departure_draft($1, 1, $2, $3)', [id, departureDoc(slug, over), 'editor']);
  const d = { id, slug, draft: 2, version: 0 };
  if (publish) await republish(d, {});
  return d;
}

/** Save `over` as a new draft, then publish it with the versions just seen. */
async function republish(d: Dep, over: Record<string, unknown>, pool: pg.Pool = db.publisher): Promise<void> {
  if (Object.keys(over).length > 0 || d.version > 0) {
    const doc = (await db.owner.query('SELECT document FROM departure_draft WHERE departure_id = $1', [d.id])).rows[0].document;
    await db.admin.query('SELECT fn_save_departure_draft($1, $2, $3, $4)', [d.id, d.draft, { ...doc, ...over }, 'editor']);
    d.draft += 1;
  }
  await pool.query('SELECT fn_publish_departure($1, $2, $3, $4)', [d.id, d.draft, d.version, 'owner']);
  d.version += 1;
}

/** A broken snapshot may not even hash (JCS refuses 1.5): the database must refuse it anyway. */
const hashOrDummy = (snapshot: unknown) => {
  try { return contractSnapshotHash(snapshot as never); } catch { return `sha256:${'c'.repeat(64)}`; }
};

/** An order of a database departure, written as the owner, its snapshot built as reserve() builds it. */
async function insertOrder(d: Dep, over: { status?: string; reservedUntil?: Date; snapshot?: unknown; unitPrice?: number;
  startsOn?: string; departureId?: string | null; snapshotSha256?: string } = {}): Promise<string> {
  const row = (await db.owner.query(`SELECT slug, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
      departure_time, return_time, timezone, price_kopecks, contract FROM departure WHERE id = $1`, [d.id])).rows[0];
  const bookable = {
    ...catalog.departures.get('altai-legacy')!, slug: row.slug, startsOn: row.starts_on, endsOn: row.ends_on,
    priceKopecks: Number(row.price_kopecks),
    contract: { tour: row.contract.tour, departure: { ...row.contract.departure, departureTime: row.departure_time, returnTime: row.return_time } },
  } as Bookable;
  const snapshot = 'snapshot' in over ? over.snapshot : buildContractSnapshot(bookable, row.timezone);
  const price = over.unitPrice ?? Number(row.price_kopecks);
  const ref = `mk-${randomBytes(6).toString('hex')}`;
  const status = over.status ?? 'RESERVED';
  const pending = status === 'RESERVED' ? '' : `, snapshot = '{}', snapshot_hash = 'refref-jcs-1:${'0'.repeat(64)}', payment_pending_since = now()`;
  await db.owner.query(`INSERT INTO orders (order_ref, departure_id, departure_slug, trip_starts_on, trip_ends_on, seats, unit_price_kopecks,
      amount_kopecks, status, reserved_until, legal_release_ref, legal_release_hash, legal_release_content, pd_consent_ref,
      pd_consent_hash, pd_consent_content, pd_consent_accepted_at, adults_only_confirmed, trip_departure_time, trip_return_time,
      trip_timezone, contract_snapshot, contract_snapshot_sha256)
    VALUES ($1, $2, $3, $4, $5, 1, $6, $6, 'RESERVED', $7, 'oferta@2026-10-04', $8, 'offer', 'soglasie-pd@2026-10-04', $8, 'consent',
      now(), true, $9, $10, $11, $12, $13)`,
  [ref, over.departureId === undefined ? d.id : over.departureId, row.slug, over.startsOn ?? row.starts_on, row.ends_on, price,
    over.reservedUntil ?? new Date(Date.now() + 30 * 60_000), `sha256:${'a'.repeat(64)}`, row.departure_time, row.return_time,
    row.timezone, snapshot, over.snapshotSha256 ?? hashOrDummy(snapshot)]);
  if (status !== 'RESERVED') await db.owner.query(`UPDATE orders SET status = $2${pending} WHERE order_ref = $1`, [ref, status]);
  return ref;
}

const publicRow = async (id: string) => (await db.owner.query('SELECT * FROM departure WHERE id = $1', [id])).rows[0];

describe('roles', () => {
  test('the service reads published offers and can change none of them', async () => {
    const d = await newDeparture();
    assert.equal((await db.pool.query('SELECT slug FROM departure WHERE id = $1', [d.id])).rows[0].slug, d.slug);
    await assert.rejects(db.pool.query('UPDATE departure SET price_kopecks = 1 WHERE id = $1', [d.id]), /permission denied/);
    await assert.rejects(db.pool.query("INSERT INTO tour (slug) VALUES ('rogue')"), /permission denied/);
    await assert.rejects(db.pool.query('SELECT * FROM departure_draft'), /permission denied/);
    await assert.rejects(db.pool.query('SELECT fn_publish_departure($1, 1, 1, $2)', [d.id, 'service']), /permission denied/);
    await assert.rejects(db.pool.query('SELECT fn_save_departure_draft($1, 1, $2, $3)', [d.id, {}, 'service']), /permission denied/);
    await assert.rejects(db.pool.query("SELECT fn_set_sales_open(true, 'service', 'reopen')"), /permission denied/);
  });

  test('the Admin API edits only through the editorial functions and never touches orders or the switch', async () => {
    const d = await newDeparture();
    for (const sql of ['UPDATE departure SET price_kopecks = 1', 'UPDATE departure SET booking_status = \'OPEN\'',
      'UPDATE departure SET is_listed = true', 'UPDATE tour SET title = \'x\'', 'DELETE FROM departure',
      'UPDATE departure_draft SET revision = 99', 'SELECT * FROM orders', "INSERT INTO tour (slug) VALUES ('direct')", 'UPDATE orders SET status = \'PAID\'']) {
      await assert.rejects(db.admin.query(sql), /permission denied/, sql);
    }
    await assert.rejects(db.admin.query("SELECT fn_set_sales_open(true, 'admin', 'reopen')"), /permission denied/);
    assert.equal((await publicRow(d.id)).booking_status, 'CLOSED');
    assert.equal((await publicRow(d.id)).is_listed, false);
  });

  test('a login that is both Admin and service is refused by the editorial functions themselves', async () => {
    await db.owner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_test_admin_service') THEN
        CREATE ROLE commerce_test_admin_service LOGIN PASSWORD 'commerce-test-only' IN ROLE admin_app, admin_publisher, commerce_app;
      END IF; END $$`);
    const u = new URL(db.url);
    u.username = 'commerce_test_admin_service';
    u.password = 'commerce-test-only';
    const both = new pg.Pool({ connectionString: u.toString(), max: 1 });
    try {
      const d = await newDeparture();
      await assert.rejects(both.query('SELECT fn_publish_departure($1, 1, 1, $2)', [d.id, 'mixed']), /EDITORIAL_SERVICE_LOGIN/);
    } finally { await both.end(); }
  });
});

describe('editorial revisions', () => {
  test('save draft never changes the public row; publish switches it and keeps the revision', async () => {
    const d = await newDeparture();
    await db.admin.query('SELECT fn_save_departure_draft($1, 2, $2, $3)', [d.id, departureDoc(d.slug, { priceKopecks: 3_900_000 }), 'editor']);
    assert.equal(Number((await publicRow(d.id)).price_kopecks), 3_400_000);
    await db.publisher.query('SELECT fn_publish_departure($1, 3, 1, $2)', [d.id, 'owner']);
    const row = await publicRow(d.id);
    assert.equal(Number(row.price_kopecks), 3_900_000);
    assert.equal(row.published_version, 2);
    const revs = (await db.admin.query('SELECT version, draft_revision, document, document_sha256, published_by, login_role FROM departure_revision WHERE departure_id = $1 ORDER BY version', [d.id])).rows;
    assert.deepEqual(revs.map((r) => [r.version, r.draft_revision, r.document.priceKopecks, r.published_by, r.login_role]),
      [[1, 2, 3_400_000, 'owner', 'commerce_test_admin_publisher'], [2, 3, 3_900_000, 'owner', 'commerce_test_admin_publisher']]);
    for (const r of revs) assert.match(r.document_sha256, /^sha256:[0-9a-f]{64}$/);
  });

  test('a stale draft revision or published version is a conflict, not an overwrite', async () => {
    const d = await newDeparture();
    await assert.rejects(db.admin.query('SELECT fn_save_departure_draft($1, 0, $2, $3)', [d.id, departureDoc(d.slug), 'tab']), /DRAFT_REVISION_CONFLICT/);
    await assert.rejects(db.publisher.query('SELECT fn_publish_departure($1, 1, 0, $2)', [d.id, 'tab']), /PUBLISHED_VERSION_CONFLICT/);
    await assert.rejects(db.publisher.query('SELECT fn_publish_departure($1, 7, 1, $2)', [d.id, 'tab']), /DRAFT_REVISION_CONFLICT/);
  });

  test('two concurrent publishes with one expected version: one wins, the other conflicts', async () => {
    const d = await newDeparture();
    await db.admin.query('SELECT fn_save_departure_draft($1, 2, $2, $3)', [d.id, departureDoc(d.slug, { priceKopecks: 3_500_000 }), 'editor']);
    const a = await db.publisher.connect();
    const b = await db.publisher.connect();
    try {
      await a.query('BEGIN');
      await a.query('SELECT fn_publish_departure($1, 3, 1, $2)', [d.id, 'tab-a']);
      const second = b.query('SELECT fn_publish_departure($1, 3, 1, $2)', [d.id, 'tab-b']);
      await new Promise((r) => setTimeout(r, 200)); // b is now waiting on a's row lock
      await a.query('COMMIT');
      await assert.rejects(second, /PUBLISHED_VERSION_CONFLICT/);
    } finally { a.release(); b.release(); }
    assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM departure_revision WHERE departure_id = $1', [d.id])).rows[0].n, 2);
  });

  test('an invalid document or an unpublished tour is refused at publish', async () => {
    const d = await newDeparture(false, { timezone: 'Mars/Olympus' });
    await assert.rejects(db.publisher.query('SELECT fn_publish_departure($1, 2, 0, $2)', [d.id, 'owner']), /DEPARTURE_DOCUMENT_INVALID/);
    await db.admin.query('SELECT fn_save_departure_draft($1, 2, $2, $3)', [d.id, { ...departureDoc(d.slug), extra: 1 }, 'editor']);
    await assert.rejects(db.publisher.query('SELECT fn_publish_departure($1, 3, 0, $2)', [d.id, 'owner']), /DEPARTURE_DOCUMENT_INVALID/);
    // A departure of an unpublished tour cannot even be created (0009): nothing to resolve it from.
    const tour = (await db.admin.query('SELECT fn_create_tour($1, $2) AS id', [uniq('tour'), 'editor'])).rows[0].id;
    await assert.rejects(db.admin.query('SELECT fn_create_departure($1, $2, $3)', [tour, uniq('x'), 'editor']), /TOUR_NOT_PUBLISHED/);
  });

  test('published revisions can be neither changed nor removed', async () => {
    const d = await newDeparture();
    await assert.rejects(db.owner.query('UPDATE departure_revision SET published_by = $2 WHERE departure_id = $1', [d.id, 'x']), /EDITORIAL_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('DELETE FROM departure_revision WHERE departure_id = $1', [d.id]), /EDITORIAL_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('TRUNCATE departure_revision CASCADE'), /EDITORIAL_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('DELETE FROM tour_revision'), /EDITORIAL_HISTORY_IMMUTABLE/);
  });
});

describe('identity', () => {
  test('slug, tour binding and published_at are fixed after the first publication', async () => {
    const d = await newDeparture();
    const other = await publishedTour();
    await assert.rejects(republish(d, { slug: uniq('renamed') }), /DEPARTURE_IDENTITY_IMMUTABLE/);
    for (const [sql, args] of [
      ['UPDATE departure SET slug = $2 WHERE id = $1', [d.id, uniq('renamed')]],
      ['UPDATE departure SET tour_id = $2 WHERE id = $1', [d.id, other.id]],
      ["UPDATE departure SET published_at = now() - interval '1 day' WHERE id = $1", [d.id]],
      ['UPDATE departure SET published_at = NULL, published_version = NULL WHERE id = $1', [d.id]],
      ['UPDATE departure SET id = gen_random_uuid() WHERE id = $1', [d.id]],
    ] as const) {
      await assert.rejects(db.owner.query(sql, [...args]), /DEPARTURE_IDENTITY_IMMUTABLE/, sql);
    }
    await assert.rejects(db.owner.query('UPDATE tour SET slug = $2 WHERE id = $1', [other.id, uniq('renamed')]), /TOUR_IDENTITY_IMMUTABLE/);
    await assert.rejects(db.owner.query('UPDATE tour SET published_at = NULL, published_version = NULL WHERE id = $1', [other.id]), /TOUR_IDENTITY_IMMUTABLE/);
  });

  test('before the first publication the slug may still change', async () => {
    const d = await newDeparture(false);
    const renamed = uniq('renamed');
    await db.admin.query('SELECT fn_save_departure_draft($1, 2, $2, $3)', [d.id, departureDoc(renamed), 'editor']);
    await db.publisher.query('SELECT fn_publish_departure($1, 3, 0, $2)', [d.id, 'owner']);
    assert.equal((await publicRow(d.id)).slug, renamed);
  });

  test('a published departure or tour is never deleted; an unpublished one may be', async () => {
    const d = await newDeparture();
    await assert.rejects(db.owner.query('DELETE FROM departure WHERE id = $1', [d.id]), /DEPARTURE_PUBLISHED_UNDELETABLE/);
    await assert.rejects(db.owner.query('TRUNCATE departure CASCADE'), /EDITORIAL_HISTORY_IMMUTABLE/);
    const tour = (await publicRow(d.id)).tour_id;
    await assert.rejects(db.owner.query('DELETE FROM tour WHERE id = $1', [tour]), /TOUR_PUBLISHED_UNDELETABLE/);
    const draft = await newDeparture(false);
    await db.owner.query('DELETE FROM departure_draft WHERE departure_id = $1', [draft.id]);
    assert.equal((await db.owner.query('DELETE FROM departure WHERE id = $1', [draft.id])).rowCount, 1);
  });

  test('an order holds its departure: ON DELETE RESTRICT even with the triggers out of the way', async () => {
    const d = await newDeparture();
    await insertOrder(d);
    await db.owner.query('ALTER TABLE departure DISABLE TRIGGER trg_departure_published_undeletable');
    try {
      await assert.rejects(db.owner.query('DELETE FROM departure WHERE id = $1', [d.id]), /violates foreign key constraint/);
    } finally { await db.owner.query('ALTER TABLE departure ENABLE TRIGGER trg_departure_published_undeletable'); }
  });
});

describe('date lock', () => {
  const moved = { startsOn: '2027-06-08', endsOn: '2027-06-11' };

  test('dates change freely while the departure has no orders', async () => {
    const d = await newDeparture();
    await republish(d, moved);
    await republish(d, { departureTime: '07:30', timezone: 'Asia/Novosibirsk' });
    const row = await publicRow(d.id);
    assert.deepEqual([row.departure_time, row.timezone], ['07:30', 'Asia/Novosibirsk']);
  });

  for (const status of ['RESERVED', 'PAYMENT_PENDING', 'HELD', 'PAID', 'FULFILLED']) {
    test(`a ${status} order locks dates, times and timezone, through Admin and directly`, async () => {
      const d = await newDeparture();
      const ref = await insertOrder(d);
      if (status !== 'RESERVED') {
        const extra = status === 'HELD' ? ", hold_reason = 'TEST'" : status === 'PAID' ? ', payment_id = gen_random_uuid(), paid_at = now()'
          : status === 'FULFILLED' ? ', payment_id = gen_random_uuid(), paid_at = now(), fulfilled_at = now()' : '';
        await db.owner.query(`UPDATE orders SET status = $2, snapshot = '{}', snapshot_hash = 'refref-jcs-1:${'0'.repeat(64)}',
          payment_pending_since = now()${extra} WHERE order_ref = $1`, [ref, status]);
      }
      // A refused publish leaves the saved draft: the next attempt starts from its revision.
      await assert.rejects(republish(d, moved), /DEPARTURE_SCHEDULE_LOCKED/);
      await assert.rejects(republish(d, { returnTime: '22:00' }), /DEPARTURE_SCHEDULE_LOCKED/);
      assert.equal((await publicRow(d.id)).published_version, 1);
      await assert.rejects(db.owner.query("UPDATE departure SET timezone = 'Europe/Moscow' WHERE id = $1", [d.id]), /DEPARTURE_SCHEDULE_LOCKED/);
      await assert.rejects(db.owner.query("UPDATE departure SET starts_on = starts_on + 7, ends_on = ends_on + 7 WHERE id = $1", [d.id]), /DEPARTURE_SCHEDULE_LOCKED/);
    });
  }

  test('an expired reservation or an ended order no longer locks them', async () => {
    const d = await newDeparture();
    await insertOrder(d, { reservedUntil: new Date(Date.now() - 60_000) });
    const ended = await insertOrder(d);
    await db.owner.query(`UPDATE orders SET status = 'CANCELLED', closed_at = now() WHERE order_ref = $1`, [ended]);
    await republish(d, moved);
    assert.equal((await db.owner.query(`SELECT to_char(starts_on, 'YYYY-MM-DD') AS s FROM departure WHERE id = $1`, [d.id])).rows[0].s, moved.startsOn);
  });

  test('an order made before departures lived in the database locks its slug too', async () => {
    await setSalesOpen(db.operator, true, 'test', 'open for the test');
    const historic = await newDeparture();
    const ref = await insertOrder(historic, { departureId: null });
    await db.owner.query('ALTER TABLE orders DISABLE TRIGGER trg_order_contract_immutable');
    await db.owner.query('ALTER TABLE orders DISABLE TRIGGER trg_frozen_trip_schedule');
    try {
      await db.owner.query("UPDATE orders SET departure_slug='altai-legacy', contract_snapshot=NULL, contract_snapshot_sha256=NULL WHERE order_ref=$1", [ref]);
    } finally {
      await db.owner.query('ALTER TABLE orders ENABLE TRIGGER trg_order_contract_immutable');
      await db.owner.query('ALTER TABLE orders ENABLE TRIGGER trg_frozen_trip_schedule');
    }
    const tour = await publishedTour();
    const id = (await db.admin.query('SELECT fn_create_departure($1, $2, $3) AS id', [tour.id, 'altai-legacy', 'editor'])).rows[0].id;
    await db.admin.query('SELECT fn_save_departure_draft($1, 1, $2, $3)', [id, departureDoc('altai-legacy'), 'editor']);
    await assert.rejects(db.publisher.query('SELECT fn_publish_departure($1, 2, 0, $2)', [id, 'owner']), /DEPARTURE_SCHEDULE_LOCKED/);
    await db.owner.query("UPDATE orders SET status = 'EXPIRED', closed_at = now() WHERE departure_slug = 'altai-legacy'");
  });

  test('an order must match the departure as published now, and only a published one', async () => {
    const d = await newDeparture();
    await assert.rejects(insertOrder(d, { startsOn: '2027-06-02' }), /ORDER_DEPARTURE_SCHEDULE_MISMATCH|orders_contract_snapshot_valid/);
    const draft = await newDeparture(false);
    await db.owner.query(`UPDATE departure SET starts_on = '2027-06-01', ends_on = '2027-06-04', departure_time = '06:00', return_time = '21:00',
      timezone = 'Asia/Krasnoyarsk', price_kopecks = 3400000, contract = $2 WHERE id = $1`, [draft.id, storedContract()]);
    await assert.rejects(insertOrder(draft), /ORDER_DEPARTURE_NOT_PUBLISHED/);
  });
});

describe('the order contract snapshot', () => {
  test('price and programme edits apply to the departure only; existing snapshots stay byte-identical', async () => {
    const d = await newDeparture();
    const ref = await insertOrder(d);
    const before = (await db.owner.query('SELECT contract_snapshot::text AS s, contract_snapshot_sha256 AS h, unit_price_kopecks FROM orders WHERE order_ref = $1', [ref])).rows[0];
    const contract = storedContract() as { tour: { program: unknown[] } };
    await republish(d, { priceKopecks: 2_900_000, content: { description: 'Обновлённое описание' } });
    assert.equal(Number((await publicRow(d.id)).price_kopecks), 2_900_000);
    // A programme change reaches a sold departure only as a classified execution change (0009).
    const doc = (await db.owner.query('SELECT document FROM departure_draft WHERE departure_id = $1', [d.id])).rows[0].document;
    await db.admin.query('SELECT fn_save_departure_draft($1, $2, $3, $4)', [d.id, d.draft,
      { ...doc, contract: { ...contract, tour: { ...contract.tour, program: [{ title: 'День 1', items: ['Новая программа'] }] } } }, 'editor']);
    await db.publisher.query('SELECT fn_publish_departure_change($1, $2, $3, $4, $5, $6)',
      [d.id, d.draft + 1, d.version, 'EQUIVALENT', 'Экскурсия заменена равноценной', 'owner']);
    const afterRow = (await db.owner.query('SELECT contract_snapshot::text AS s, contract_snapshot_sha256 AS h, contract_snapshot AS j, unit_price_kopecks FROM orders WHERE order_ref = $1', [ref])).rows[0];
    assert.equal(afterRow.s, before.s);
    assert.equal(afterRow.h, before.h);
    assert.equal(afterRow.unit_price_kopecks, before.unit_price_kopecks);
    assert.ok(contractSnapshotIntact(afterRow.j, afterRow.h));
    assert.equal(afterRow.j.unitPriceKopecks, 3_400_000);
  });

  test('a snapshot is never updated, backfilled or detached: not by the service, not directly', async () => {
    const d = await newDeparture();
    const ref = await insertOrder(d);
    await assert.rejects(db.pool.query(`UPDATE orders SET contract_snapshot = jsonb_set(contract_snapshot, '{unitPriceKopecks}', '1') WHERE order_ref = $1`, [ref]), /ORDER_CONTRACT_SNAPSHOT_IMMUTABLE/);
    await assert.rejects(db.owner.query(`UPDATE orders SET contract_snapshot_sha256 = $2 WHERE order_ref = $1`, [ref, `sha256:${'b'.repeat(64)}`]), /ORDER_CONTRACT_SNAPSHOT_IMMUTABLE/);
    await assert.rejects(db.owner.query('UPDATE orders SET contract_snapshot = NULL, contract_snapshot_sha256 = NULL WHERE order_ref = $1', [ref]), /ORDER_CONTRACT_SNAPSHOT_IMMUTABLE/);
    await assert.rejects(db.owner.query('UPDATE orders SET departure_id = NULL WHERE order_ref = $1', [ref]), /ORDER_CONTRACT_SNAPSHOT_IMMUTABLE/);
    // The columns it is bound to cannot drift from it either.
    await assert.rejects(db.pool.query(`UPDATE orders SET trip_starts_on = trip_starts_on + 1 WHERE order_ref = $1`, [ref]), /orders_contract_snapshot_valid/);
    await assert.rejects(db.pool.query(`UPDATE orders SET unit_price_kopecks = 1, amount_kopecks = 1 WHERE order_ref = $1`, [ref]), /orders_contract_snapshot_valid/);
    for (const status of ['PAYMENT_PENDING', 'PAID']) {
      const later = await insertOrder(d, { status: status === 'PAID' ? 'PAYMENT_PENDING' : status });
      if (status === 'PAID') await db.owner.query(`UPDATE orders SET status = 'PAID', payment_id = gen_random_uuid(), paid_at = now() WHERE order_ref = $1`, [later]);
      await assert.rejects(db.owner.query(`UPDATE orders SET contract_snapshot = '{}' WHERE order_ref = $1`, [later]), /ORDER_CONTRACT_SNAPSHOT_IMMUTABLE/);
    }
  });

  test('a new order without a snapshot, or with one that disagrees with it, is refused', async () => {
    const d = await newDeparture();
    await assert.rejects(insertOrder(d, { snapshot: null }), /ORDER_CONTRACT_SNAPSHOT_REQUIRED/);
    await assert.rejects(insertOrder(d, { unitPrice: 3_000_000 }), /orders_contract_snapshot_valid/);
    const base = buildContractSnapshot(catalog.departures.get('altai-legacy') as Bookable, 'Asia/Krasnoyarsk');
    for (const broken of [
      { ...base, departureSlug: d.slug, startsOn: '2027-06-01', endsOn: '2027-06-04', unitPriceKopecks: 3_400_000, extra: true },
      { ...base, departureSlug: d.slug, startsOn: '2027-06-01', endsOn: '2027-06-04', unitPriceKopecks: 3_400_000,
        contract: { ...base.contract, tour: { ...base.contract.tour, program: [] } } },
      { ...base, departureSlug: d.slug, startsOn: '2027-06-01', endsOn: '2027-06-04', unitPriceKopecks: 3_400_000,
        contract: { ...base.contract, departure: { ...base.contract.departure, accommodation: { ...base.contract.departure.accommodation, nights: 1.5 } } } },
    ]) {
      await assert.rejects(insertOrder(d, { snapshot: broken }), /orders_contract_snapshot_valid/);
    }
  });

  test('SQL shape/format admission does not attest JCS integrity; the independent verifier refuses a wrong digest', async () => {
    const d = await newDeparture();
    const ref = await insertOrder(d, { snapshotSha256: `sha256:${'0'.repeat(64)}` });
    const row = (await db.owner.query('SELECT contract_snapshot AS s, contract_snapshot_sha256 AS h FROM orders WHERE order_ref=$1', [ref])).rows[0];
    assert.equal(contractSnapshotIntact(row.s, row.h), false);
    assert.notEqual(contractSnapshotHash(row.s), row.h);
  });

  test('reserve() stores the resolved contract of the departure it sold, and a later catalog does not reach it', async () => {
    await setSalesOpen(db.operator, true, 'test', 'open for the test');
    const c = fixtureCatalog([{ slug: 'altai-reserve', startsOn: '2027-08-01', endsOn: '2027-08-04', price: 26500 }]);
    await seedCatalog(db, c);
    const req: BookingRequest = { departureSlug: 'altai-reserve', contact: { phone: '+79039075547', email: 'ivan@example.ru' },
      passengers: [tourist(1), tourist(2)], adultsOnlyConfirmed: true, termsRef: c.terms.ref, termsHash: c.terms.hash,
      pdConsentConfirmed: true, pdConsentRef: c.pdConsent.ref, pdConsentHash: c.pdConsent.hash };
    const r = await reserve({ pool: db.pool, catalog: c, log: () => undefined, allowDemo: false, now: () => NOW }, req);
    assert.ok(r.ok);
    const row = (await db.owner.query('SELECT contract_snapshot AS s, contract_snapshot_sha256 AS h FROM orders WHERE order_ref = $1', [r.orderRef])).rows[0];
    assert.deepEqual(row.s, buildContractSnapshot(c.departures.get('altai-reserve') as Bookable, 'Asia/Krasnoyarsk'));
    assert.ok(contractSnapshotIntact(row.s, row.h));
    assert.equal(row.s.unitPriceKopecks, 2_650_000);
    assert.equal(row.s.contract.departure.accommodation.name, 'Гостевой дом «Озеро»');
    assert.equal(contractSnapshotIntact({ ...row.s, unitPriceKopecks: 1 }, row.h), false);
  });
});

test('schema restore: a logical dump restored into an empty database enforces the same invariants', async () => {
  const d = await newDeparture();
  const ref = await insertOrder(d);
  const doc = (await db.owner.query('SELECT document FROM departure_draft WHERE departure_id = $1', [d.id])).rows[0].document;
  await db.admin.query('SELECT fn_save_departure_draft($1, $2, $3, $4)', [d.id, d.draft,
    { ...doc, contract: { ...doc.contract, tour: { ...doc.contract.tour, route: 'Изменённый маршрут' } } }, 'editor']);
  const changeArgs = [d.id, d.draft + 1, d.version, 'MATERIAL', 'Маршрут недоступен.', 'owner'];
  const changeSql = 'SELECT fn_publish_departure_change($1, $2, $3, $4, $5, $6) AS r';
  const change = (await db.publisher.query(changeSql, changeArgs)).rows[0].r;
  const { stdout: dump } = await run('pg_dump', ['--no-password', db.url.toString()], { maxBuffer: 64 * 1024 * 1024 });
  const name = `${db.name}_restore`;
  await db.owner.query(`CREATE DATABASE ${name}`);
  const url = new URL(db.url);
  url.pathname = `/${name}`;
  const restored = new pg.Client({ connectionString: url.toString() });
  try {
    const child = execFile('psql', ['--no-psqlrc', '--quiet', '-v', 'ON_ERROR_STOP=1', url.toString()]);
    const done = new Promise<void>((resolve, reject) => child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`psql exited ${code}`)))));
    child.stdin!.end(dump);
    await done;
    await restored.connect();
    const versions = (await restored.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(versions, (await db.owner.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows);
    assert.equal(versions.at(-1).version, schemaHead(MIGRATIONS_DIR));
    await assert.rejects(restored.query('UPDATE departure SET slug = $2 WHERE id = $1', [d.id, 'restored-rename']), /DEPARTURE_IDENTITY_IMMUTABLE/);
    await assert.rejects(restored.query('DELETE FROM departure WHERE id = $1', [d.id]), /DEPARTURE_PUBLISHED_UNDELETABLE/);
    await assert.rejects(restored.query("UPDATE departure SET starts_on = starts_on + 7, ends_on = ends_on + 7 WHERE id = $1", [d.id]), /DEPARTURE_SCHEDULE_LOCKED/);
    await assert.rejects(restored.query(`UPDATE orders SET contract_snapshot = '{}' WHERE order_ref = $1`, [ref]), /ORDER_CONTRACT_SNAPSHOT_IMMUTABLE/);
    // 0009: the editorial audit is restored and stays append-only.
    assert.ok((await restored.query('SELECT count(*)::int AS n FROM editorial_audit WHERE entity_id = $1', [d.id])).rows[0].n >= 3);
    await assert.rejects(restored.query('DELETE FROM editorial_audit WHERE entity_id = $1', [d.id]), /EDITORIAL_HISTORY_IMMUTABLE/);
    // 0010: the restored pending operation replays without new events, and its identity is unique.
    assert.deepEqual((await restored.query(changeSql, changeArgs)).rows[0].r, change);
    await assert.rejects(restored.query(changeSql, [d.id, d.draft + 1, d.version, 'EQUIVALENT', changeArgs[4], 'owner']),
      /EXECUTION_CHANGE_CONFLICT/);
    await assert.rejects(restored.query(`INSERT INTO departure_execution_change
      (departure_id, classification, outcome, from_version, draft_revision, notice, affected_order_refs, classified_by, login_role, created_at)
      SELECT departure_id, classification, outcome, from_version, draft_revision, notice, affected_order_refs, classified_by, login_role, created_at
        FROM departure_execution_change WHERE id = $1`, [change.changeId]), /duplicate key.*departure_execution_change_identity/);
    assert.equal((await restored.query("SELECT count(*)::int AS n FROM order_event WHERE event = 'EXECUTION_CHANGE_MATERIAL' AND detail = $1", [change.changeId])).rows[0].n, 1);
    const s = (await restored.query('SELECT contract_snapshot AS j, contract_snapshot_sha256 AS h FROM orders WHERE order_ref = $1', [ref])).rows[0];
    assert.ok(contractSnapshotIntact(s.j, s.h));
  } finally {
    await restored.end().catch(() => undefined);
    await db.owner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
});

test('reserve() holds the schedule lock until its real order commits', async () => {
  const d = await newDeparture();
  await db.owner.query("UPDATE departure SET booking_status='OPEN',is_listed=true,capacity=12 WHERE id=$1", [d.id]);
  await db.owner.query('UPDATE tour SET is_listed=true WHERE id=(SELECT tour_id FROM departure WHERE id=$1)', [d.id]);
  const c = fixtureCatalog([{ slug: d.slug, startsOn: '2027-06-01', endsOn: '2027-06-04', price: 34000 }]);
  await setSalesOpen(db.operator, true, 'test', 'concurrent reservation');
  const editor = new pg.Client({ connectionString: db.url.toString() });
  await editor.connect();
  const editorPid = (await editor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const gate = uniq('reserve-gate');
  // Pause the actual reserve() inside its INSERT, after it acquired the departure lock.
  await db.owner.query(`CREATE FUNCTION fn_test_pause_reservation() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${gate}',0)); RETURN NEW; END $f$`);
  await db.owner.query(`CREATE TRIGGER zz_test_pause_reservation BEFORE INSERT ON orders
    FOR EACH ROW WHEN (NEW.departure_slug = '${d.slug}') EXECUTE FUNCTION fn_test_pause_reservation()`);
  await db.owner.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [gate]);
  const waitFor = async (sql: string, args: unknown[]) => {
    for (let n = 0; n < 100; n++) {
      if ((await db.owner.query(sql, args)).rows[0].ready) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('expected a real blocked database operation');
  };
  let booking: ReturnType<typeof reserve> | undefined;
  let update: Promise<string> | undefined;
  try {
    const request: BookingRequest = { departureSlug: d.slug, contact: { phone: '+79039075547', email: 'ivan@example.ru' },
      passengers: [tourist(1)], adultsOnlyConfirmed: true, termsRef: c.terms.ref, termsHash: c.terms.hash,
      pdConsentConfirmed: true, pdConsentRef: c.pdConsent.ref, pdConsentHash: c.pdConsent.hash };
    booking = reserve({ pool: db.pool, catalog: c, log: () => undefined, allowDemo: false, now: () => new Date() }, request);
    await waitFor(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=$1
      AND usename='commerce_test_runtime' AND wait_event='advisory') AS ready`, [db.name]);
    update = editor.query('UPDATE departure SET starts_on=starts_on+7, ends_on=ends_on+7 WHERE id=$1', [d.id])
      .then(() => 'UPDATED', (error: Error) => error.message);
    await waitFor('SELECT cardinality(pg_blocking_pids($1)) > 0 AS ready', [editorPid]);
    await db.owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [gate]);
    assert.equal((await booking).ok, true);
    assert.match(await update, /DEPARTURE_SCHEDULE_LOCKED/);
  } finally {
    await db.owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [gate]);
    await booking?.catch(() => undefined);
    await update;
    await editor.end();
    await db.owner.query('DROP TRIGGER zz_test_pause_reservation ON orders');
    await db.owner.query('DROP FUNCTION fn_test_pause_reservation()');
  }
});
