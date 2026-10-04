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
  await db.owner.query('TRUNCATE email_outbox, order_document, order_event, order_passenger, order_contact, orders');
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
  assert.equal(await processEmailOutbox(db.pool, sender, logs.log, now), 1);
  let row = (await db.owner.query('SELECT state, attempts, provider_job_id, last_error_code FROM email_outbox')).rows[0];
  assert.deepEqual(row, { state: 'PENDING', attempts: 1, provider_job_id: null, last_error_code: 'TIMEOUT' });
  assert.equal(await processEmailOutbox(db.pool, sender, logs.log, new Date(now.getTime() + 30_000)), 1);
  row = (await db.owner.query('SELECT state, attempts, provider_job_id, access_token, last_error_code FROM email_outbox')).rows[0];
  assert.deepEqual(row, { state: 'ACCEPTED', attempts: 2, provider_job_id: 'job-2', access_token: null, last_error_code: null });
  assert.deepEqual(seen, [key, key]);
  assert.ok(!logs.lines.join('\n').includes('ivan@example.ru'));
});

test('a definitive refusal goes to operator attention and is not retried', async () => {
  await pending();
  const sender: EmailSender = { send: async () => ({ kind: 'REJECTED', code: 'FROM_EMAIL_INVALID' }) };
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, now), 1);
  assert.deepEqual((await db.owner.query('SELECT state, attempts, last_error_code FROM email_outbox')).rows[0],
    { state: 'ATTENTION', attempts: 1, last_error_code: 'FROM_EMAIL_INVALID' });
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, new Date(now.getTime() + 60_000)), 0);
});
