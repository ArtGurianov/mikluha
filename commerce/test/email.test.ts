import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { processEmailOutbox, UniSenderGoClient, type EmailSender } from '../src/email.js';
import { reserve } from '../src/orders.js';
import { captureLog, fixtureCatalog, freshDb, tourist, type TestDb } from './helpers.js';

let db: TestDb;
const catalog = fixtureCatalog([{ slug: 'altai-mail', startsOn: '2026-11-01', endsOn: '2026-11-04' }]);
const now = new Date('2026-10-04T06:00:00Z');

before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });
beforeEach(async () => {
  await db.owner.query('TRUNCATE order_eis_event, order_eis, email_outbox, order_document, order_event, order_passenger, order_contact, orders');
  await db.owner.query(`UPDATE sales_switch SET open = true`);
});

async function pending(): Promise<{ ref: string; key: string }> {
  const r = await reserve({ pool: db.pool, catalog, log: () => undefined, allowDemo: false, now: () => now }, {
    departureSlug: 'altai-mail', contact: { phone: '+79039075547', email: 'ivan@example.ru' }, passengers: [tourist()],
    adultsOnlyConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
    pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
  });
  assert.ok(r.ok);
  const key = `mk-confirm:${r.orderRef}`;
  await db.pool.query(`INSERT INTO email_outbox
    (order_id, type, recipient_email, access_token, idempotency_key, state, attempts, next_attempt_at, created_at)
    SELECT id, 'BOOKING_CONFIRMATION', 'ivan@example.ru', $2, $3, 'PENDING', 0, $4, $4 FROM orders WHERE order_ref = $1`,
  [r.orderRef, 'a'.repeat(43), key, now]);
  return { ref: r.orderRef, key };
}

test('UniSender acceptance requires a readable success and job id; payload has no unsubscribe or tourist data', async () => {
  let requestBody = '';
  const client = new UniSenderGoClient({ apiKey: 'secret', fromEmail: 'noreply@mikluha.example', fromName: 'Миклуха',
    commerceOrigin: 'https://book.mikluha.example' }, async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ status: 'success', job_id: 'job-1', failed_emails: {} }), { status: 200 });
  });
  assert.deepEqual(await client.send({ recipient: 'ivan@example.ru', orderRef: 'mk-000000000001',
    accessToken: 'a'.repeat(43), idempotencyKey: 'mk-confirm:1' }),
    { kind: 'ACCEPTED', jobId: 'job-1' });
  const body = JSON.parse(requestBody);
  assert.equal(body.message.idempotence_key, 'mk-confirm:1');
  assert.equal(body.message.recipients[0].email, 'ivan@example.ru');
  assert.match(requestBody, /\/documents\/a{43}/);
  assert.ok(!/unsubscribe|list-unsubscribe/i.test(requestBody));
  for (const forbidden of ['Петров', '3210', '654321', '1990-05-17']) assert.ok(!requestBody.includes(forbidden));
});

test('ambiguous delivery is retried with the same identity and acceptance stores job_id', async () => {
  const { key } = await pending();
  const seen: string[] = [];
  let calls = 0;
  const sender: EmailSender = { send: async (input) => {
    seen.push(input.idempotencyKey);
    calls += 1;
    return calls === 1 ? { kind: 'AMBIGUOUS', code: 'TIMEOUT' } : { kind: 'ACCEPTED', jobId: 'job-2' };
  } };
  const logs = captureLog();
  assert.equal(await processEmailOutbox(db.pool, sender, logs.log, () => now), 1);
  let row = (await db.owner.query(
    'SELECT state, attempts, first_attempt_at, provider_job_id, last_error_code FROM email_outbox')).rows[0];
  assert.deepEqual(row, { state: 'PENDING', attempts: 1, first_attempt_at: now,
    provider_job_id: null, last_error_code: 'TIMEOUT' });
  assert.equal(await processEmailOutbox(db.pool, sender, logs.log, () => new Date(now.getTime() + 10_000)), 1);
  row = (await db.owner.query('SELECT state, attempts, provider_job_id, access_token, last_error_code FROM email_outbox')).rows[0];
  assert.deepEqual(row, { state: 'ACCEPTED', attempts: 2, provider_job_id: 'job-2', access_token: null, last_error_code: null });
  assert.deepEqual(seen, [key, key]);
  assert.ok(!logs.lines.join('\n').includes('ivan@example.ru'));
});

test('a definitive refusal goes to operator attention and is not retried', async () => {
  await pending();
  const sender: EmailSender = { send: async () => ({ kind: 'REJECTED', code: 'FROM_EMAIL_INVALID' }) };
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => now), 1);
  assert.deepEqual((await db.owner.query('SELECT state, attempts, last_error_code FROM email_outbox')).rows[0],
    { state: 'ATTENTION', attempts: 1, last_error_code: 'FROM_EMAIL_INVALID' });
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => new Date(now.getTime() + 60_000)), 0);
});

test('an accepted response lost past one minute cannot cause a second provider acceptance', async () => {
  await pending();
  let providerAcceptances = 0;
  const sender: EmailSender = { send: async () => {
    providerAcceptances += 1;
    return { kind: 'AMBIGUOUS', code: 'TRANSPORT' };
  } };
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => now), 1);
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined,
    () => new Date(now.getTime() + 61_000)), 1);
  assert.equal(providerAcceptances, 1);
  assert.deepEqual((await db.owner.query('SELECT state, attempts, last_error_code FROM email_outbox')).rows[0],
    { state: 'ATTENTION', attempts: 1, last_error_code: 'DEDUPE_WINDOW_EXPIRED' });
});

test('the conservative retry-start deadline is exclusive', async () => {
  await pending();
  let sends = 0;
  const sender: EmailSender = { send: async () => {
    sends += 1;
    return { kind: 'AMBIGUOUS', code: 'TIMEOUT' };
  } };
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => now), 1);
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined,
    () => new Date(now.getTime() + 40_000)), 1);
  assert.equal(sends, 1);
  assert.equal((await db.owner.query('SELECT state FROM email_outbox')).rows[0].state, 'ATTENTION');
});

test('an expired send lease outside the dedupe window becomes attention without resending', async () => {
  await pending();
  await db.owner.query(`UPDATE email_outbox SET state = 'SENDING', attempts = 1, first_attempt_at = $1,
    lease_until = $2, next_attempt_at = $1 WHERE state = 'PENDING'`,
  [now, new Date(now.getTime() + 120_000)]);
  let sends = 0;
  const sender: EmailSender = { send: async () => { sends += 1; return { kind: 'ACCEPTED', jobId: 'unsafe' }; } };
  const afterLease = new Date(now.getTime() + 121_000);
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => afterLease), 1);
  assert.equal(sends, 0);
  assert.deepEqual((await db.owner.query('SELECT state, attempts, last_error_code FROM email_outbox')).rows[0],
    { state: 'ATTENTION', attempts: 1, last_error_code: 'DEDUPE_WINDOW_EXPIRED' });
});

test('HTTP 408 is ambiguous and API 1573 is a distinct duplicate-key outcome', async () => {
  const config = { apiKey: 'secret', fromEmail: 'noreply@mikluha.example', fromName: 'Миклуха',
    commerceOrigin: 'https://book.mikluha.example' };
  const input = { recipient: 'ivan@example.ru', orderRef: 'mk-000000000001', accessToken: 'a'.repeat(43),
    idempotencyKey: 'mk-confirm:1' };
  const timedOut = new UniSenderGoClient(config, async () => new Response('{}', { status: 408 }));
  assert.deepEqual(await timedOut.send(input), { kind: 'AMBIGUOUS', code: 'HTTP_408' });
  const duplicate = new UniSenderGoClient(config, async () =>
    new Response(JSON.stringify({ status: 'error', code: 1573 }), { status: 400 }));
  assert.deepEqual(await duplicate.send(input), { kind: 'DUPLICATE', code: 'IDEMPOTENCE_DUPLICATE' });
});

test('API 1573 requires operator reconciliation instead of another automatic send', async () => {
  await pending();
  let sends = 0;
  const sender: EmailSender = { send: async () => {
    sends += 1;
    return { kind: 'DUPLICATE', code: 'IDEMPOTENCE_DUPLICATE' };
  } };
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => now), 1);
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined,
    () => new Date(now.getTime() + 10_000)), 0);
  assert.equal(sends, 1);
  assert.deepEqual((await db.owner.query('SELECT state, attempts, last_error_code FROM email_outbox')).rows[0],
    { state: 'ATTENTION', attempts: 1, last_error_code: 'IDEMPOTENCE_DUPLICATE' });
});
