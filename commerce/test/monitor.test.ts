import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import type { Catalog } from '../src/catalog.js';
import { commerceMonitorSignals, monitorHasAlert } from '../src/monitor.js';
import { reserve, setSalesOpen, type BookingRequest } from '../src/orders.js';
import { fixtureCatalog, freshDb, tourist, type TestDb } from './helpers.js';

const NOW = new Date('2026-10-04T06:00:00Z');
let db: TestDb;
let catalog: Catalog;

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: 'altai-2026-11-01', startsOn: '2026-11-01', endsOn: '2026-11-04' }]);
});
after(async () => { await db.drop(); });
beforeEach(async () => {
  await db.owner.query('TRUNCATE order_eis_event, order_eis, email_outbox, order_document, order_event, order_passenger, order_contact, orders');
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
});

const request = (): BookingRequest => ({
  departureSlug: 'altai-2026-11-01', contact: { phone: '+79039075547', email: 'ivan@example.ru' },
  passengers: [tourist()], adultsOnlyConfirmed: true,
  termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
});

async function createOrder(): Promise<string> {
  const result = await reserve({ pool: db.pool, catalog, log: () => undefined, allowDemo: false, now: () => NOW }, request());
  assert.ok(result.ok);
  return result.orderRef;
}

test('monitor output is aggregate-only and alerts on aged PAID or any HELD order', async () => {
  const paidRef = await createOrder();
  const heldRef = await createOrder();
  const recentRef = await createOrder();
  const frozen = `snapshot = '{}', snapshot_hash = 'refref-jcs-1:${'0'.repeat(64)}', payment_pending_since = $2`;
  await db.owner.query(`UPDATE orders SET status = 'PAID', ${frozen}, payment_id = gen_random_uuid(), paid_at = $2
    WHERE order_ref = $1`, [paidRef, new Date(NOW.getTime() - 600_000)]);
  await db.owner.query(`UPDATE orders SET status = 'HELD', ${frozen}, hold_reason = 'TEST_HOLD'
    WHERE order_ref = $1`, [heldRef, new Date(NOW.getTime() - 120_000)]);
  await db.owner.query(`UPDATE orders SET status = 'PAID', ${frozen}, payment_id = gen_random_uuid(), paid_at = $2
    WHERE order_ref = $1`, [recentRef, new Date(NOW.getTime() - 60_000)]);

  const signals = await commerceMonitorSignals(db.pool, NOW, 300);
  assert.deepEqual(signals, {
    observedAt: NOW.toISOString(),
    paidNotFulfilled: { count: 1, oldestSeconds: 600 },
    held: { count: 1, oldestSeconds: 120 },
  });
  assert.equal(monitorHasAlert(signals), true);
  const serialized = JSON.stringify(signals);
  for (const forbidden of [paidRef, heldRef, recentRef, 'TEST_HOLD', 'ivan@example.ru']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('monitor is clean when no actionable order is present', async () => {
  assert.equal(monitorHasAlert(await commerceMonitorSignals(db.pool, NOW)), false);
});

test('monitor refuses an invalid grace period', async () => {
  await assert.rejects(commerceMonitorSignals(db.pool, NOW, -1), /MONITOR_PAID_GRACE_INVALID/);
});
