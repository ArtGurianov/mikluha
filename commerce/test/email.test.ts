import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import { NotisendClient, OUTBOX_KEY_HEADER, processEmailOutbox, type EmailSender } from '../src/email.js';
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

const config = { apiKey: 'secret', fromEmail: 'noreply@mikluha.example', fromName: 'Миклуха',
  commerceOrigin: 'https://book.mikluha.example' };
const input = { recipient: 'ivan@example.ru', orderRef: 'mk-000000000001', accessToken: 'a'.repeat(43),
  outboxKey: 'mk-confirm:1' };
const respond = (status: number, body: unknown) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('Notisend acceptance requires a readable message id and a queued status; payload has no unsubscribe or tourist data', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const client = new NotisendClient({ ...config, replyTo: 'artur@mikluha.example' }, async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({ id: 4711, to: 'ivan@example.ru', status: 'queued' }), { status: 200 });
  });
  assert.deepEqual(await client.send(input), { kind: 'ACCEPTED', jobId: '4711' });
  assert.equal(requestUrl, 'https://api.notisend.ru/v1/email/messages');
  assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer secret');
  assert.equal(requestInit?.redirect, 'error');
  const requestBody = String(requestInit?.body);
  const body = JSON.parse(requestBody);
  assert.equal(body.to, 'ivan@example.ru');
  assert.equal(body.from_email, 'noreply@mikluha.example');
  assert.deepEqual(body.smtp_headers, { [OUTBOX_KEY_HEADER]: 'mk-confirm:1', 'Reply-To': 'artur@mikluha.example' });
  assert.match(body.text, /\/documents\/a{43}/);
  assert.match(body.html, /\/documents\/a{43}/);
  assert.ok(!/unsubscribe|list-unsubscribe/i.test(requestBody));
  for (const forbidden of ['Петров', '3210', '654321', '1990-05-17']) assert.ok(!requestBody.includes(forbidden));
});

test('a redirect after the original POST cannot become NOT_SENT or leak the document bearer', async () => {
  let redirectedRequests = 0;
  const destination = createServer((_request, response) => {
    redirectedRequests += 1;
    response.end(JSON.stringify({ id: 1, status: 'queued' }));
  });
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const destinationAddress = destination.address();
  assert.ok(destinationAddress !== null && typeof destinationAddress === 'object');
  const source = createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${destinationAddress.port}/foreign` });
    response.end();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourceAddress = source.address();
  assert.ok(sourceAddress !== null && typeof sourceAddress === 'object');
  try {
    assert.deepEqual(await new NotisendClient({ ...config,
      apiBase: `http://127.0.0.1:${sourceAddress.port}/messages` }).send(input),
    { kind: 'AMBIGUOUS', code: 'TRANSPORT' });
    assert.equal(redirectedRequests, 0);
  } finally {
    source.closeAllConnections(); destination.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => source.close(() => resolve())),
      new Promise<void>((resolve) => destination.close(() => resolve()))]);
  }
});

test('oversized or broken success bodies remain ambiguous without reflected provider data', async () => {
  assert.deepEqual(await new NotisendClient(config, respond(200,
    JSON.stringify({ id: 1, status: 'queued', padding: 'x'.repeat(16_384) }))).send(input),
  { kind: 'AMBIGUOUS', code: 'UNREADABLE_RESPONSE' });
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.error(new Error(`${input.recipient} ${input.accessToken} ${config.apiKey}`));
  } });
  assert.deepEqual(await new NotisendClient(config, async () => new Response(body)).send(input),
    { kind: 'AMBIGUOUS', code: 'UNREADABLE_RESPONSE' });
});

test('the client says NOT_SENT only when Notisend cannot have queued the message', async () => {
  const throttled = { errors: [{ code: 429, detail: 'Too many messages. Try again in 92 seconds.' }] };
  assert.deepEqual(await new NotisendClient(config, respond(429, throttled)).send(input),
    { kind: 'NOT_SENT', code: 'HTTP_429', retryAfterMs: 92_000 });
  assert.deepEqual(await new NotisendClient(config, respond(429, '')).send(input),
    { kind: 'NOT_SENT', code: 'HTTP_429', retryAfterMs: 60_000 });
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.deepEqual(await new NotisendClient(config, async () => { throw refused; }).send(input),
    { kind: 'NOT_SENT', code: 'ECONNREFUSED', retryAfterMs: 30_000 });
  const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  assert.deepEqual(await new NotisendClient(config, async () => { throw reset; }).send(input),
    { kind: 'AMBIGUOUS', code: 'TRANSPORT' });
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.deepEqual(await new NotisendClient(config, async () => { throw aborted; }).send(input),
    { kind: 'AMBIGUOUS', code: 'TIMEOUT' });
  for (const status of [408, 500, 502]) {
    assert.deepEqual(await new NotisendClient(config, respond(status, {})).send(input),
      { kind: 'AMBIGUOUS', code: `HTTP_${status}` });
  }
  assert.deepEqual(await new NotisendClient(config, respond(200, '<html>')).send(input),
    { kind: 'AMBIGUOUS', code: 'UNREADABLE_RESPONSE' });
  assert.deepEqual(await new NotisendClient(config, respond(200, { id: 1, status: 'paused' })).send(input),
    { kind: 'AMBIGUOUS', code: 'UNREADABLE_RESPONSE' });
});

test('Notisend refusals and skipped recipients are definitive', async () => {
  for (const status of [400, 401, 402, 422]) {
    assert.deepEqual(await new NotisendClient(config,
      respond(status, { errors: [{ code: status, detail: 'subject is empty' }] })).send(input),
    { kind: 'REJECTED', code: `HTTP_${status}` });
  }
  assert.deepEqual(await new NotisendClient(config, respond(200, { id: 9, status: 'skipped' })).send(input),
    { kind: 'REJECTED', code: 'RECIPIENT_SKIPPED' });
});

test('a provably unsent message is retried with the same outbox key, and acceptance stores the message id', async () => {
  const { key } = await pending();
  const seen: string[] = [];
  let calls = 0;
  const sender: EmailSender = { send: async (message) => {
    seen.push(message.outboxKey);
    calls += 1;
    return calls === 1 ? { kind: 'NOT_SENT', code: 'HTTP_429', retryAfterMs: 92_000 } : { kind: 'ACCEPTED', jobId: '4712' };
  } };
  const logs = captureLog();
  assert.equal(await processEmailOutbox(db.pool, sender, logs.log, () => now), 1);
  let row = (await db.owner.query(
    'SELECT state, attempts, first_attempt_at, next_attempt_at, provider_job_id, last_error_code FROM email_outbox')).rows[0];
  assert.deepEqual(row, { state: 'PENDING', attempts: 1, first_attempt_at: now,
    next_attempt_at: new Date(now.getTime() + 92_000), provider_job_id: null, last_error_code: 'HTTP_429' });
  assert.equal(await processEmailOutbox(db.pool, sender, logs.log, () => new Date(now.getTime() + 91_000)), 0);
  assert.equal(await processEmailOutbox(db.pool, sender, logs.log, () => new Date(now.getTime() + 92_000)), 1);
  row = (await db.owner.query('SELECT state, attempts, provider_job_id, access_token, last_error_code FROM email_outbox')).rows[0];
  assert.deepEqual(row, { state: 'ACCEPTED', attempts: 2, provider_job_id: '4712', access_token: null, last_error_code: null });
  assert.deepEqual(seen, [key, key]);
  assert.ok(!logs.lines.join('\n').includes('ivan@example.ru'));
});

test('a definitive refusal goes to operator attention and is not retried', async () => {
  await pending();
  const sender: EmailSender = { send: async () => ({ kind: 'REJECTED', code: 'HTTP_422' }) };
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => now), 1);
  assert.deepEqual((await db.owner.query('SELECT state, attempts, last_error_code FROM email_outbox')).rows[0],
    { state: 'ATTENTION', attempts: 1, last_error_code: 'HTTP_422' });
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => new Date(now.getTime() + 60_000)), 0);
});

test('an unknown outcome is never sent again: Notisend has no idempotency key', async () => {
  await pending();
  let sends = 0;
  const sender: EmailSender = { send: async () => {
    sends += 1;
    return { kind: 'AMBIGUOUS', code: 'TIMEOUT' };
  } };
  const logs = captureLog();
  assert.equal(await processEmailOutbox(db.pool, sender, logs.log, () => now), 1);
  for (const later of [10_000, 61_000, 3_600_000]) {
    assert.equal(await processEmailOutbox(db.pool, sender, logs.log, () => new Date(now.getTime() + later)), 0);
  }
  assert.equal(sends, 1);
  assert.deepEqual((await db.owner.query('SELECT state, attempts, last_error_code FROM email_outbox')).rows[0],
    { state: 'ATTENTION', attempts: 1, last_error_code: 'TIMEOUT' });
  assert.match(logs.lines.join('\n'), /outcome_unknown/);
});

test('an expired send lease becomes attention without resending', async () => {
  await pending();
  await db.owner.query(`UPDATE email_outbox SET state = 'SENDING', attempts = 1, first_attempt_at = $1,
    lease_until = $2, next_attempt_at = $1 WHERE state = 'PENDING'`,
  [now, new Date(now.getTime() + 120_000)]);
  let sends = 0;
  const sender: EmailSender = { send: async () => { sends += 1; return { kind: 'ACCEPTED', jobId: 'unsafe' }; } };
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => new Date(now.getTime() + 119_000)), 0);
  assert.equal(await processEmailOutbox(db.pool, sender, () => undefined, () => new Date(now.getTime() + 120_000)), 1);
  assert.equal(sends, 0);
  assert.deepEqual((await db.owner.query('SELECT state, attempts, last_error_code FROM email_outbox')).rows[0],
    { state: 'ATTENTION', attempts: 1, last_error_code: 'LEASE_EXPIRED' });
});

test('safe retries stop at the attempt limit and go to operator attention', async () => {
  await pending();
  let sends = 0;
  const sender: EmailSender = { send: async () => {
    sends += 1;
    return { kind: 'NOT_SENT', code: 'ECONNREFUSED', retryAfterMs: 30_000 };
  } };
  for (let i = 0; i < 12; i += 1) {
    await processEmailOutbox(db.pool, sender, () => undefined, () => new Date(now.getTime() + i * 30_000));
  }
  assert.equal(sends, 10);
  assert.deepEqual((await db.owner.query('SELECT state, attempts, last_error_code FROM email_outbox')).rows[0],
    { state: 'ATTENTION', attempts: 10, last_error_code: 'ECONNREFUSED' });
});
