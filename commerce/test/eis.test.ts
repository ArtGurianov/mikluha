import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import pg from 'pg';

import { eisFilingPacket, eisRecords, markEisNeedsUpdate, recordEisSubmitted } from '../src/eis.js';
import { maintain, reserve } from '../src/orders.js';
import { fixtureCatalog, forceStatus, freshDb, tourist, type TestDb } from './helpers.js';

let db: TestDb;
const now = new Date('2026-10-04T06:00:00Z');
const catalog = fixtureCatalog([{ slug: 'altai-eis', startsOn: '2026-11-01', endsOn: '2026-11-04' }]);

before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });
beforeEach(async () => {
  await db.owner.query('TRUNCATE order_eis_event, order_eis, email_outbox, order_document, order_event, order_passenger, order_contact, orders');
  await db.owner.query('UPDATE sales_switch SET open = true');
});

async function order(paid = true): Promise<string> {
  const r = await reserve({ pool: db.pool, catalog, log: () => undefined, allowDemo: false, now: () => now }, {
    departureSlug: 'altai-eis', contact: { phone: '+79039075547', email: 'ivan@example.ru' },
    passengers: [tourist()], adultsOnlyConfirmed: true, termsRef: catalog.terms.ref,
    termsHash: catalog.terms.hash, pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref,
    pdConsentHash: catalog.pdConsent.hash,
  });
  assert.ok(r.ok);
  if (paid) await forceStatus(db.owner, r.orderRef, 'FULFILLED');
  return r.orderRef;
}

test('a proven paid contract atomically creates one EIS_PENDING record and event', async () => {
  const unpaid = await order(false);
  assert.deepEqual(await eisRecords(db.operator, unpaid), []);
  await forceStatus(db.owner, unpaid, 'FULFILLED');
  assert.deepEqual(await eisRecords(db.operator, unpaid), [{
    orderRef: unpaid, status: 'EIS_PENDING', electronicVoucherNumber: null, submittedAt: null,
    submittedBy: null, submittedLoginRole: null, lastMarkedNeedsUpdateAt: null, needsUpdateReason: null,
    materialRevision: 0, submittedRevision: null,
  }]);
  // A later paid-state transition cannot create a second filing obligation.
  await db.owner.query(`UPDATE orders SET status = 'PAID', fulfilled_at = NULL WHERE order_ref = $1`, [unpaid]);
  assert.equal((await db.owner.query('SELECT count(*) AS n FROM order_eis')).rows[0].n, '1');
  assert.deepEqual((await db.owner.query(
    'SELECT from_status, to_status, changed_by, reason FROM order_eis_event')).rows,
  [{ from_status: null, to_status: 'EIS_PENDING', changed_by: 'system:payment', reason: 'PAYMENT_CONFIRMED' }]);
});

test('only an operator explicitly records submission after filing in the EIS personal account', async () => {
  const ref = await order();
  await assert.rejects(db.pool.query('SELECT fn_eis_record_submitted($1, $2, $3, $4)', [ref, 'ЭП-001', 'service', 0]),
    /permission denied for function fn_eis_record_submitted/);
  await assert.rejects(db.pool.query(`UPDATE order_eis SET status = 'EIS_SUBMITTED'`), /permission denied/);

  const submitted = await recordEisSubmitted(db.operator, ref, ' ЭП-001 ', ' Artur ', 0);
  assert.equal(submitted.status, 'EIS_SUBMITTED');
  assert.equal(submitted.electronicVoucherNumber, 'ЭП-001');
  assert.equal(submitted.submittedBy, 'Artur');
  assert.equal(submitted.submittedLoginRole, 'commerce_test_operator');
  assert.equal(submitted.submittedRevision, 0);
  assert.ok(submitted.submittedAt instanceof Date);
  await assert.rejects(recordEisSubmitted(db.operator, ref, 'ЭП-002', 'Artur', 0), /EIS_ALREADY_SUBMITTED/);
});

test('a login shared with the runtime role cannot record EIS submission', async () => {
  const ref = await order();
  await db.owner.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_test_eis_both') THEN
      CREATE ROLE commerce_test_eis_both LOGIN PASSWORD 'commerce-test-only' IN ROLE commerce_app, commerce_operator;
    END IF; END $$`);
  const url = new URL(db.url);
  url.username = 'commerce_test_eis_both';
  url.password = 'commerce-test-only';
  const both = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    await assert.rejects(recordEisSubmitted(both, ref, 'ЭП-001', 'Artur', 0), /EIS_SERVICE_LOGIN/);
  } finally {
    await both.end();
  }
  assert.equal((await eisRecords(db.operator, ref))[0]!.status, 'EIS_PENDING');
});

test('pending cannot be marked needs-update or submitted without an actual voucher number', async () => {
  const ref = await order();
  await assert.rejects(markEisNeedsUpdate(db.operator, ref, 'Artur', 'portal correction'), /EIS_NOT_SUBMITTED/);
  await assert.rejects(recordEisSubmitted(db.operator, ref, '', 'Artur', 0), /EIS_VOUCHER_NUMBER_INVALID/);
  assert.equal((await eisRecords(db.operator, ref))[0]!.status, 'EIS_PENDING');
});

test('tourist and contract changes after submission fail closed into EIS_NEEDS_UPDATE', async () => {
  const ref = await order();
  await recordEisSubmitted(db.operator, ref, 'ЭП-001', 'Artur', 0);
  await db.owner.query(`UPDATE order_passenger SET document_number = '654399'
    WHERE order_id = (SELECT id FROM orders WHERE order_ref = $1)`, [ref]);
  let state = (await eisRecords(db.operator, ref))[0]!;
  assert.equal(state.status, 'EIS_NEEDS_UPDATE');
  assert.equal(state.needsUpdateReason, 'TOURIST_DATA_CHANGED');
  assert.ok(state.lastMarkedNeedsUpdateAt instanceof Date);

  assert.equal(state.materialRevision, 1);
  await recordEisSubmitted(db.operator, ref, 'ЭП-001-ИЗМ', 'Artur', 1);
  await db.owner.query(`UPDATE orders SET legal_release_ref = legal_release_ref || '-corrected' WHERE order_ref = $1`, [ref]);
  state = (await eisRecords(db.operator, ref))[0]!;
  assert.equal(state.status, 'EIS_NEEDS_UPDATE');
  assert.equal(state.needsUpdateReason, 'CONTRACT_DATA_CHANGED');
  assert.equal(state.electronicVoucherNumber, 'ЭП-001-ИЗМ');
  assert.equal(state.materialRevision, 2);
  assert.equal(state.submittedRevision, 1);
});

test('submission refuses a filing packet whose material revision changed after review', async () => {
  const ref = await order();
  const reviewed = (await eisRecords(db.operator, ref))[0]!;
  assert.equal(reviewed.materialRevision, 0);
  await db.owner.query(`UPDATE order_passenger SET document_number = '654399'
    WHERE order_id = (SELECT id FROM orders WHERE order_ref = $1)`, [ref]);
  await assert.rejects(recordEisSubmitted(db.operator, ref, 'ЭП-001', 'Artur', reviewed.materialRevision),
    /EIS_PACKET_STALE/);
  const current = (await eisRecords(db.operator, ref))[0]!;
  assert.equal(current.status, 'EIS_PENDING');
  assert.equal(current.materialRevision, 1);
  await recordEisSubmitted(db.operator, ref, 'ЭП-001', 'Artur', current.materialRevision);
  assert.equal((await eisRecords(db.operator, ref))[0]!.status, 'EIS_SUBMITTED');
});

test('an operator can explicitly mark an external filing mismatch, then record the corrected submission', async () => {
  const ref = await order();
  await recordEisSubmitted(db.operator, ref, 'ЭП-001', 'Artur', 0);
  const needs = await markEisNeedsUpdate(db.operator, ref, 'Artur', 'ЕИС ЛК rejected supplier correction');
  assert.equal(needs.status, 'EIS_NEEDS_UPDATE');
  assert.equal(needs.needsUpdateReason, 'ЕИС ЛК rejected supplier correction');
  const corrected = await recordEisSubmitted(db.operator, ref, 'ЭП-002', 'Artur', 0);
  assert.equal(corrected.status, 'EIS_SUBMITTED');
  assert.equal(corrected.needsUpdateReason, null);
  assert.ok(corrected.lastMarkedNeedsUpdateAt instanceof Date);
  assert.deepEqual((await db.owner.query('SELECT to_status FROM order_eis_event ORDER BY id')).rows.map((r) => r.to_status),
    ['EIS_PENDING', 'EIS_SUBMITTED', 'EIS_NEEDS_UPDATE', 'EIS_SUBMITTED']);
});

test('the filing packet is operator-readable and contains the stored contract and tourist facts', async () => {
  const ref = await order(false);
  const id = (await db.owner.query('SELECT id FROM orders WHERE order_ref = $1', [ref])).rows[0].id;
  await db.owner.query(`INSERT INTO order_document (order_id, kind, content, sha256, created_at)
    VALUES ($1, 'ZAYAVKA', 'frozen contract', $2, $3)`, [id, 'a'.repeat(64), now]);
  await forceStatus(db.owner, ref, 'FULFILLED');
  const packet = await eisFilingPacket(db.operator, ref);
  assert.ok(packet);
  assert.equal(packet.order.order_ref, ref);
  assert.equal(packet.order.eis_material_revision, '0');
  assert.equal(packet.contact.email, 'ivan@example.ru');
  assert.equal(packet.tourists[0]!.document_number, '654321');
  assert.equal(packet.contract.content, 'frozen contract');
});

test('scheduled retention erasure is not misreported as a factual EIS change', async () => {
  const ref = await order();
  await recordEisSubmitted(db.operator, ref, 'ЭП-001', 'Artur', 0);
  assert.equal((await maintain(db.pool, () => undefined, new Date('2027-02-03T12:00:00Z'))).erased, 1);
  const state = (await eisRecords(db.operator, ref))[0]!;
  assert.equal(state.status, 'EIS_SUBMITTED');
  assert.equal(state.needsUpdateReason, null);
});

test('a post-submission refund marks the filing stale', async () => {
  const ref = await order();
  await recordEisSubmitted(db.operator, ref, 'ЭП-001', 'Artur', 0);
  await db.owner.query(`UPDATE orders SET status = 'REFUNDED', closed_at = $2 WHERE order_ref = $1`, [ref, now]);
  const state = (await eisRecords(db.operator, ref))[0]!;
  assert.equal(state.status, 'EIS_NEEDS_UPDATE');
  assert.equal(state.needsUpdateReason, 'CONTRACT_DATA_CHANGED');
});
