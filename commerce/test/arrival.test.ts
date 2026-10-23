// TOUR arrival on the commerce origin (Refref docs/29 §2, §4, §6, §8; ART-382) through the real HTTP
// routes, a real Postgres for the order form and a model of Refref's vNext claimArrival.
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  ATTEMPT_CEILING_MS, arrivalTarget, Arrivals, BUY_BUDGET_MS, CONTEXT_COOKIE, CONTEXT_MAX_AGE_SECONDS, MAX_ACTIVE_CLAIMS, RETRY_INTERVAL_MS,
} from '../src/arrival.js';
import type { Catalog } from '../src/catalog.js';
import type { CheckoutDeps } from '../src/checkout.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { schemaHead } from '../src/migrate.js';
import { setSalesOpen } from '../src/orders.js';
import { BookingRateLimiter } from '../src/rate-limit.js';
import { RefrefClient } from '../src/refref.js';
import { createCommerceServer } from '../src/server.js';
import { createWebHandler } from '../src/web.js';
import { FakeRefref } from './fake-refref.js';
import { captureLog, seedCatalog, fixtureCatalog, freshDb, type TestDb } from './helpers.js';

const MERCHANT_ID = '3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90';
const COMMERCE = 'https://book.mikluha.example';
const SITE = 'https://mikluha.example';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PD = ['Иван', 'Петров', '9039075547', '903 907', 'ivan@example.ru', '654321', '3210', '1990-05-17'];

type Behaviour = 'OK' | 'HANG' | 'ERROR_500' | { status: number; code: string };

/** Refref's claimArrival (docs/openapi-vnext.yaml): issued proofs, one context per Arrival, 30m claims. */
class FakeVnext {
  readonly requests: { path: string; key: string | undefined; body: Record<string, unknown> }[] = [];
  readonly issued = new Map<string, number>();
  readonly claims = new Map<string, string>();
  readonly closed = new Set<string>();
  /** Answers for the next claims, in order; then OK. */
  next: Behaviour[] = [];
  now = () => Date.now();
  base = '';
  active = 0;
  peak = 0;
  #server: Server | null = null;
  #hung: (() => void)[] = [];

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { text += c; });
      req.on('end', () => {
        const body = JSON.parse(text) as { arrivalProof: string; browserContextId: string; storefrontOrigin: string };
        this.requests.push({ path: req.url ?? '', key: req.headers['idempotency-key'] as string | undefined, body });
        const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        this.active++; this.peak = Math.max(this.peak, this.active);
        res.once('close', () => { this.active--; });
        const b = this.next.shift() ?? 'OK';
        if (b === 'HANG') { this.#hung.push(() => res.destroy()); return; }
        if (b === 'ERROR_500') { send(500, { error: { code: 'INTERNAL' } }); return; }
        if (typeof b === 'object') { send(b.status, { error: { code: b.code } }); return; }
        const issuedAt = this.issued.get(body.arrivalProof);
        const owner = this.claims.get(body.arrivalProof);
        if (this.closed.has(body.browserContextId)) { send(409, { error: { code: 'CONTEXT_CLOSED' } }); return; }
        if (owner !== undefined && owner !== body.browserContextId) { send(409, { error: { code: 'ARRIVAL_ALREADY_CLAIMED' } }); return; }
        const receipt = { claimId: '5b0c7a8e-2f1d-4c3b-9a8e-7d6c5b4a3f21', browserContextId: body.browserContextId,
          storefrontOrigin: body.storefrontOrigin, claimedAt: new Date(this.now()).toISOString(),
          eligibleUntil: new Date(this.now() + 30 * DAY).toISOString() };
        if (owner !== undefined) { send(200, receipt); return; }
        if (issuedAt === undefined || this.now() > issuedAt + 30 * MINUTE || body.storefrontOrigin !== COMMERCE) {
          send(422, { error: { code: 'ARRIVAL_PROOF_INVALID' } }); return;
        }
        this.claims.set(body.arrivalProof, body.browserContextId);
        send(201, receipt);
      });
    });
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/v1-vnext`;
  }

  /** What r.refref.ru does on a click: a fresh `ar1.` proof, valid for claims for 30 minutes. */
  issue(): string {
    const proof = `ar1.${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
    this.issued.set(proof, this.now());
    return proof;
  }

  reset(): void {
    for (const h of this.#hung.splice(0)) h();
    this.peak = this.active;
    this.requests.length = 0; this.issued.clear(); this.claims.clear(); this.closed.clear(); this.next = [];
  }

  async stop(): Promise<void> {
    this.reset();
    this.#server?.closeAllConnections();
    await new Promise((r) => this.#server?.close(() => r(undefined)));
  }
}

let db: TestDb;
let catalog: Catalog;
let refref: FakeRefref;
let vnext: FakeVnext;
let server: Server;
let base: string;
let clock: Date;
let logs: ReturnType<typeof captureLog>;
let arrivals: Arrivals;
let checkoutDeps: CheckoutDeps;

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: 'altai-2026-11-01', startsOn: '2026-11-01', endsOn: '2026-11-04', capacity: 3 }]);
  await seedCatalog(db, catalog);
  refref = new FakeRefref(MERCHANT_ID);
  await refref.start();
  vnext = new FakeVnext();
  vnext.now = () => clock.getTime();
  await vnext.start();
  logs = captureLog();
  const log: CheckoutDeps['log'] = (e, f) => logs.log(e, f);
  const deps: CheckoutDeps = checkoutDeps = {
    pool: db.pool, catalog, log, now: () => clock,
    refref: new RefrefClient({ apiBase: refref.base, apiKey: 'rk_test', timeoutMs: 1500 }),
    merchant: { businessId: MERCHANT_ID, businessSlug: 'mikluha', checkoutOrigin: 'https://checkout.refref.example',
      origin: COMMERCE, siteOrigin: SITE },
  };
  arrivals = new Arrivals({ refref: new RefrefClient({ apiBase: vnext.base, apiKey: 'rk_test', timeoutMs: ATTEMPT_CEILING_MS }),
    storefrontOrigin: COMMERCE, log, now: () => clock });
  server = createCommerceServer({ pool: db.pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR), sourceCommit: null,
    startedAt: new Date(), onError: (e) => log('request_failed', { error: e instanceof Error ? e.name : 'unknown' }) },
  createWebHandler(deps, false, new BookingRateLimiter({ ipLimit: 10_000, emailLimit: 10_000 }), arrivals));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await arrivals.after.drain();
  await refref.stop();
  await vnext.stop();
  await db.drop();
});
beforeEach(async () => {
  clock = new Date('2026-10-04T06:00:00Z');
  await arrivals.after.drain();
  vnext.reset();
  refref.reset();
  logs.lines.length = 0;
  await db.owner.query('TRUNCATE order_eis_event, order_eis, email_outbox, order_document, order_event, order_passenger, order_contact, orders CASCADE');
  await setSalesOpen(db.operator, true, 'test', 'open');
});

interface Reply { status: number; location: string | undefined; setCookie: string[]; headers: Record<string, unknown>; body: string }

function http(method: string, path: string, opts: { cookie?: string; form?: Record<string, string>; base?: string } = {}): Promise<Reply> {
  const payload = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const req = request(`${opts.base ?? base}${path}`, { method, headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(payload ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(payload)) } : {}),
    } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location,
        setCookie: res.headers['set-cookie'] ?? [], headers: res.headers, body }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The browser's context cookie from a response, as `name=value`, or undefined. */
const contextOf = (r: Reply) => r.setCookie.find((c) => c.startsWith(`${CONTEXT_COOKIE}=`))?.split(';')[0];
const idOf = (cookie: string) => cookie.slice(CONTEXT_COOKIE.length + 1);

const bookingForm = (): Record<string, string> => ({
  departure: 'altai-2026-11-01', termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsent: 'yes', pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
  contactPhone: '+7 903 907-55-47', contactEmail: 'ivan@example.ru', adultsOnly: 'yes',
  t1Name: 'Иван Петров', t1Dob: '1990-05-17', t1Citizenship: 'RU', t1DocType: 'RU_PASSPORT', t1DocSeries: '3210', t1DocNumber: '654321',
});

describe('the arrival endpoint', () => {
  test('sets a host-only 30-day context cookie and redirects to a clean site page without waiting for Refref', async () => {
    const proof = vnext.issue();
    vnext.next = ['HANG'];
    const started = Date.now();
    const r = await http('GET', `/arrive?arrival=${proof}&to=${encodeURIComponent('/tours/altai/?utm_source=p')}`);
    assert.ok(Date.now() - started < ATTEMPT_CEILING_MS, 'the landing never waits for the claim');
    assert.equal(r.status, 302);
    assert.equal(r.location, `${SITE}/tours/altai/?utm_source=p`);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    const cookie = r.setCookie.find((c) => c.startsWith(`${CONTEXT_COOKIE}=`))!;
    const attrs = cookie.split(';').map((a) => a.trim());
    assert.match(attrs[0]!, new RegExp(`^${CONTEXT_COOKIE}=[A-Za-z0-9_-]{43}$`));
    assert.deepEqual(attrs.slice(1).sort(), ['HttpOnly', `Max-Age=${CONTEXT_MAX_AGE_SECONDS}`, 'Path=/', 'SameSite=Lax', 'Secure']);
    assert.equal(CONTEXT_MAX_AGE_SECONDS, 30 * 24 * 3600);
    assert.ok(!attrs.some((a) => /^domain=/i.test(a)), 'host-only');
    assert.ok(!r.location!.includes(proof) && !r.body.includes(proof));
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 1, 'the mandatory after-response attempt was made');
    assert.deepEqual(vnext.requests[0]!.body, { arrivalProof: proof, browserContextId: idOf(attrs[0]!), storefrontOrigin: COMMERCE });
    assert.equal(vnext.requests[0]!.path, '/v1-vnext/integrations/arrival-claims');
  });

  test('an arrival burst still redirects while actual outgoing HTTP concurrency stays bounded', async () => {
    // Give this load test its own transport/server so aborted sockets cannot reach another test.
    const fake = new FakeVnext();
    await fake.start();
    fake.next = Array.from({ length: 200 }, () => 'HANG');
    const loaded = new Arrivals({ refref: new RefrefClient({ apiBase: fake.base, apiKey: 'rk_test' }),
      storefrontOrigin: COMMERCE, log: logs.log });
    const local = createCommerceServer({ pool: db.pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR),
      sourceCommit: null, startedAt: new Date() }, createWebHandler(checkoutDeps, false, undefined, loaded));
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    try {
      const replies = await Promise.all(Array.from({ length: 100 }, () =>
        http('GET', `/arrive?arrival=${fake.issue()}&to=/tours/`, { base: localBase })));
      for (const r of replies) {
        assert.equal(r.status, 302);
        assert.equal(r.location, `${SITE}/tours/`);
        assert.ok(contextOf(r));
      }
      assert.ok(fake.active > 0, 'landings returned while outgoing claims are still hung');
      await loaded.after.drain();
      assert.ok(fake.peak <= MAX_ACTIVE_CLAIMS, `peak actual HTTP concurrency: ${fake.peak}`);
      assert.ok(logs.lines.some((l) => l.includes('OVERLOADED')), 'overflow is explicit');
      for (const r of replies) assert.deepEqual(loaded.degradation(idOf(contextOf(r)!)), { degraded: true, reason: 'TIMEOUT' });
    } finally {
      local.closeAllConnections();
      await new Promise<void>((resolve) => local.close(() => resolve()));
      await loaded.after.drain();
      await fake.stop();
    }
  });

  test('a later arrival in the same browser reuses its context; a click without a cookie gets a new one', async () => {
    const first = await http('GET', `/arrive?arrival=${vnext.issue()}&to=/`);
    const cookie = contextOf(first)!;
    const again = await http('GET', `/arrive?arrival=${vnext.issue()}&to=/`, { cookie });
    assert.equal(contextOf(again), cookie, 'the window is renewed for the same context');
    const other = await http('GET', `/arrive?arrival=${vnext.issue()}&to=/`);
    assert.notEqual(contextOf(other), cookie);
    await arrivals.after.drain();
    assert.deepEqual(vnext.requests.map((q) => q.body.browserContextId), [idOf(cookie), idOf(cookie), idOf(contextOf(other)!)]);
  });

  test('never blocks the buyer: no, malformed or repeated proof still sets the context and redirects', async () => {
    for (const q of ['', 'arrival=short', 'arrival=%3Cscript%3E'.padEnd(60, 'x'), `arrival=${vnext.issue()}&arrival=${vnext.issue()}`]) {
      const r = await http('GET', `/arrive?${q}&to=/tours/`);
      assert.equal(r.status, 302, q);
      assert.equal(r.location, `${SITE}/tours/`);
      assert.ok(contextOf(r));
    }
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 0);
  });

  test('redirects only to the public site', () => {
    const home = `${SITE}/`;
    for (const to of [null, '', 'https://evil.example/', '//evil.example/x', '/\\evil.example', '\\\\evil.example',
      'javascript:alert(1)', '/%0d%0aSet-Cookie:x=1'.replace('%0d%0a', '\r\n'), '/a\tb', 'tours/altai', `/${'a'.repeat(600)}`,
      'http://mikluha.example/', 'https://user:pw@mikluha.example/']) {
      assert.equal(arrivalTarget(SITE, to), home, String(to));
    }
    assert.equal(arrivalTarget(SITE, '/tours/altai/'), `${SITE}/tours/altai/`);
    assert.equal(arrivalTarget(SITE, '/%2F%2Fevil.example'), `${SITE}/%2F%2Fevil.example`);
    assert.equal(arrivalTarget(SITE, '/tours/?arrival=x&Arrival=y&ok=1#d'), `${SITE}/tours/?ok=1#d`);
  });
});

describe('exchange and retry', () => {
  test('a failed first attempt is retried after the next same-context request and confirms the claim', async () => {
    const proof = vnext.issue();
    vnext.next = ['ERROR_500'];
    const cookie = contextOf(await http('GET', `/arrive?arrival=${proof}&to=/`))!;
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 1);
    assert.deepEqual(arrivals.degradation(idOf(cookie)), { degraded: true, reason: 'TIMEOUT' });

    // Within the throttle window a request shares the previous attempt.
    await http('GET', '/book?departure=altai-2026-11-01', { cookie });
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 1);

    clock = new Date(clock.getTime() + RETRY_INTERVAL_MS);
    const page = await http('GET', '/book?departure=altai-2026-11-01', { cookie });
    assert.equal(contextOf(page), undefined, 'a known context is not re-issued');
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 2);
    assert.deepEqual(vnext.requests[1]!.body, vnext.requests[0]!.body, 'the retry is the identical claim');
    assert.equal(vnext.claims.get(proof), idOf(cookie));
    assert.deepEqual(arrivals.degradation(idOf(cookie)), { degraded: false });

    clock = new Date(clock.getTime() + RETRY_INTERVAL_MS);
    await http('GET', '/book?departure=altai-2026-11-01', { cookie });
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 2, 'nothing left to claim');
  });

  test('a claim nobody retried within 30 minutes expires and is never rescued later', async () => {
    vnext.next = ['ERROR_500'];
    const cookie = contextOf(await http('GET', `/arrive?arrival=${vnext.issue()}&to=/`))!;
    await arrivals.after.drain();
    clock = new Date(clock.getTime() + 31 * MINUTE);
    await http('GET', '/book?departure=altai-2026-11-01', { cookie });
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 1, 'no claim after the deadline');
    assert.deepEqual(await arrivals.beforeBuy(idOf(cookie)), { degraded: true, reason: 'EXPIRED' });
    assert.ok(logs.lines.some((l) => JSON.parse(l).event === 'arrival_claim_expired'));
  });

  test('before Buy: a hanging Refref costs at most 1,500 ms and is declared TIMEOUT; a refusal is FAILED', async () => {
    vnext.next = ['ERROR_500', 'HANG', 'HANG', 'HANG', 'HANG', 'HANG'];
    const cookie = contextOf(await http('GET', `/arrive?arrival=${vnext.issue()}&to=/`))!;
    await arrivals.after.drain();
    const started = Date.now();
    assert.deepEqual(await arrivals.beforeBuy(idOf(cookie)), { degraded: true, reason: 'TIMEOUT' });
    const spent = Date.now() - started;
    assert.ok(spent >= BUY_BUDGET_MS - 100 && spent < BUY_BUDGET_MS + 400, `spent ${spent} ms`);

    vnext.reset();
    const refused = contextOf(await http('GET', `/arrive?arrival=${'ar1.'.padEnd(47, 'z')}&to=/`))!;
    await arrivals.after.drain();
    assert.deepEqual(await arrivals.beforeBuy(idOf(refused)), { degraded: true, reason: 'FAILED' });
    assert.equal(vnext.requests.length, 1, 'a definitive refusal is not repeated');
  });

  test('a lost ACK on a committed claim is recovered by the identical repeat', async () => {
    const proof = vnext.issue();
    const cookie = contextOf(await http('GET', `/arrive?arrival=${proof}&to=/`))!;
    await arrivals.after.drain();
    // The first answer was lost by the merchant (simulated by a second process memory).
    const other = new Arrivals({ refref: new RefrefClient({ apiBase: vnext.base, apiKey: 'rk_test' }), storefrontOrigin: COMMERCE,
      log: () => undefined, now: () => clock });
    other.capture(idOf(cookie), proof);
    assert.deepEqual(await other.beforeBuy(idOf(cookie)), { degraded: false });
    assert.equal(vnext.requests.length, 2);
  });

  test('a context Refref refuses is replaced and never presented again; its unconfirmed proof follows the browser', async () => {
    const proof = vnext.issue();
    const first = await http('GET', `/arrive?arrival=${vnext.issue()}&to=/`);
    const cookie = contextOf(first)!;
    await arrivals.after.drain();
    vnext.closed.add(idOf(cookie));
    await http('GET', `/arrive?arrival=${proof}&to=/`, { cookie });
    await arrivals.after.drain();
    clock = new Date(clock.getTime() + RETRY_INTERVAL_MS);
    const next = await http('GET', '/book?departure=altai-2026-11-01', { cookie });
    const rotated = contextOf(next)!;
    assert.ok(rotated && rotated !== cookie, 'a new context cookie');
    await arrivals.after.drain();
    assert.equal(vnext.claims.get(proof), idOf(rotated));
    assert.equal(vnext.requests.filter((q) => q.body.browserContextId === idOf(cookie)).length, 2);
    assert.equal(logs.lines.filter((l) => JSON.parse(l).event === 'browser_context_rotated').length, 1);
    // A second tab still sending the refused cookie joins the same replacement, never the old ID.
    const tab = await http('GET', '/book?departure=altai-2026-11-01', { cookie });
    assert.equal(contextOf(tab), rotated);
    await arrivals.after.drain();
    assert.equal(vnext.requests.filter((q) => q.body.browserContextId === idOf(cookie)).length, 2);
  });
});

describe('TOUR profile: referral → static page → order form → Buy', () => {
  test('one context from arrival to Buy; Refref receives no tourist data and nothing secret is logged', async () => {
    const proof = vnext.issue();
    const landed = await http('GET', `/arrive?arrival=${proof}&to=${encodeURIComponent('/tours/altai/')}`);
    const cookie = contextOf(landed)!;
    assert.equal(landed.location, `${SITE}/tours/altai/`);
    // The static page links to the commerce order form: a top-level, same-site navigation sends the cookie.
    const form = await http('GET', '/book?departure=altai-2026-11-01', { cookie });
    assert.equal(form.status, 200);
    assert.equal(contextOf(form), undefined);
    assert.match(form.body, /<form method="post" action="\/orders">/, 'Buy is a same-origin top-level form post');
    const buy = await http('POST', '/orders', { cookie, form: bookingForm() });
    assert.equal(buy.status, 303, buy.body);
    assert.equal(contextOf(buy), undefined, 'Buy kept the arrival context');
    assert.match(buy.setCookie[0]!, /^__Host-mk_mk-/, 'the order state cookie is unchanged');
    await arrivals.after.drain();
    assert.equal(vnext.claims.get(proof), idOf(cookie));
    assert.deepEqual(await arrivals.beforeBuy(idOf(cookie)), { degraded: false });

    for (const q of vnext.requests) {
      assert.deepEqual(Object.keys(q.body).sort(), ['arrivalProof', 'browserContextId', 'storefrontOrigin']);
      for (const pd of PD) assert.ok(!JSON.stringify(q.body).includes(pd), `no ${pd} to Refref`);
    }
    for (const line of logs.lines) {
      assert.ok(!line.includes(proof), 'no proof in logs');
      assert.ok(!line.includes(idOf(cookie)), 'no context ID in logs');
    }
  });

  test('a buyer without a referral gets a context on the order form', async () => {
    const form = await http('GET', '/book?departure=altai-2026-11-01');
    assert.ok(contextOf(form));
    const buy = await http('POST', '/orders', { form: bookingForm() });
    assert.equal(buy.status, 303);
    assert.ok(contextOf(buy), 'Buy without a cookie still gets a context');
  });

  test('the context survives a 25-day return: a new arrival lands in the same context', async () => {
    const cookie = contextOf(await http('GET', `/arrive?arrival=${vnext.issue()}&to=/`))!;
    await arrivals.after.drain();
    clock = new Date(clock.getTime() + 25 * DAY);
    assert.ok(25 * DAY / 1000 < CONTEXT_MAX_AGE_SECONDS, 'the browser still holds the cookie');
    const proof = vnext.issue();
    const back = await http('GET', `/arrive?arrival=${proof}&to=/`, { cookie });
    assert.equal(contextOf(back), cookie);
    const buy = await http('POST', '/orders', { cookie, form: bookingForm() });
    assert.equal(buy.status, 303);
    assert.equal(contextOf(buy), undefined);
    await arrivals.after.drain();
    assert.equal(vnext.claims.get(proof), idOf(cookie));
  });
});

test('without a vNext API the arrival still lands, and Buy declares the proof undelivered', async () => {
  const offline = new Arrivals({ refref: null, storefrontOrigin: COMMERCE, log: () => undefined, now: () => clock });
  offline.capture('a'.repeat(43), vnext.issue());
  assert.deepEqual(await offline.beforeBuy('a'.repeat(43)), { degraded: true, reason: 'TIMEOUT' });
});
