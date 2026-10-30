// TOUR-81 · native ingress under NATIVE_NO_REFERRAL (docs/refref-v10/05 M4; MKV10-E2E-28/30/31/51/53/54/63
// native facets only). Refref's vNext claimArrival runs throughout, as if REFREF_VNEXT_API_BASE were
// set, and must receive nothing: not from /arrive, not after the response, not after a restart. The
// legacy RC read-back of an existing order is still served and is counted on its own.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import { CONTEXT_COOKIE, newContextId } from './retired/arrival.js';
import type { Catalog } from '../src/catalog.js';
import type { CheckoutDeps } from './retired/checkout.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { schemaHead } from '../src/migrate.js';
import { setSalesOpen } from '../src/orders.js';
import { BookingRateLimiter } from '../src/rate-limit.js';
import { RefrefClient } from './retired/refref.js';
import { createCommerceServer } from '../src/server.js';
import { createWebHandler } from './retired/web.js';
import { FakeRefref } from './fake-refref.js';
import { FakeVnext } from './fake-vnext.js';
import { captureLog, fixtureCatalog, freshDb, seedCatalog, type TestDb, resetOrders } from './helpers.js';

const MERCHANT_ID = '3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90';
const COMMERCE = 'https://book.mikluha.example';
const SITE = 'https://mikluha.example';
/** Longer than any after-response claim attempt (500 ms) or retry throttle (2 s) would need to start. */
const SETTLE_MS = 600;

let db: TestDb;
let catalog: Catalog;
let refref: FakeRefref;
let vnext: FakeVnext;
let server: Server;
let base: string;
let clock: Date;
let logs: ReturnType<typeof captureLog>;

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: 'altai-2026-11-01', startsOn: '2026-11-01', endsOn: '2026-11-04', capacity: 6 },
    // Far enough ahead for the real clock of the spawned service.
    { slug: 'altai-2099-06-01', startsOn: '2099-06-01', endsOn: '2099-06-04', capacity: 6 }]);
  await seedCatalog(db, catalog);
  refref = new FakeRefref(MERCHANT_ID);
  await refref.start();
  vnext = new FakeVnext(COMMERCE);
  await vnext.start();
  logs = captureLog();
  const deps: CheckoutDeps = {
    pool: db.pool, initiationPool: db.initiation, catalog, log: (e, f) => logs.log(e, f), now: () => clock,
    refref: new RefrefClient({ apiBase: refref.base, apiKey: 'rk_test', timeoutMs: 1500 }),
    merchant: { businessId: MERCHANT_ID, businessSlug: 'mikluha', checkoutOrigin: 'https://checkout.refref.example',
      origin: COMMERCE, siteOrigin: SITE },
  };
  // Exactly what src/bin/serve.ts builds: there is no Arrivals and no vNext client to pass.
  server = createCommerceServer({ pool: db.pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR), sourceCommit: null,
    startedAt: new Date() }, createWebHandler(deps, false, new BookingRateLimiter({ ipLimit: 10_000, emailLimit: 10_000 })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await refref.stop();
  await vnext.stop();
  await db.drop();
});
beforeEach(async () => {
  clock = new Date('2026-10-04T06:00:00Z');
  vnext.reset();
  refref.reset();
  logs.lines.length = 0;
  await resetOrders(db.owner);
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

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));
/** A context cookie a browser may still hold from before TOUR-81. */
const oldContext = () => `${CONTEXT_COOKIE}=${newContextId()}`;

const bookingForm = (email = 'ivan@example.ru', departure = 'altai-2026-11-01'): Record<string, string> => ({
  departure, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsent: 'yes', pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
  contactPhone: '+7 903 907-55-47', contactEmail: email, adultsOnly: 'yes',
  t1Name: 'Иван Петров', t1Dob: '1990-05-17', t1Citizenship: 'RU', t1DocType: 'RU_PASSPORT', t1DocSeries: '3210', t1DocNumber: '654321',
});

/** What a browser, an autofill or a hand-made request could add: none of it is a field of the order. */
const PROMO_NOISE = {
  promo: 'FRIEND50', promoCode: 'FRIEND50', code: 'FRIEND50', coupon: 'FRIEND50', apply: '1', applyPromo: 'yes',
  ref: 'partner-1', referrer: 'partner-1', partner: 'partner-1', utm_source: 'partner-1', discount: '99999',
  discountKopecks: '99999', price: '1', amountKopecks: '1', payableKopecks: '1', profile: 'REFERRAL', arrival: 'ar1.'.padEnd(47, 'p'),
};

describe('/arrive under NATIVE_NO_REFERRAL', () => {
  test('a valid proof is dropped: no cookie, no claim, no Refref call; the buyer still lands on the clean page', async () => {
    const proof = vnext.issue();
    const r = await http('GET', `/arrive?arrival=${proof}&to=${encodeURIComponent('/tours/altai/?utm_source=p&arrival=x')}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, `${SITE}/tours/altai/?utm_source=p`);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.deepEqual(r.setCookie, [], 'no context cookie: no referral window is opened');
    assert.ok(!r.location!.includes(proof) && !r.body.includes(proof));
    await settle();
    assert.equal(vnext.hits, 0, 'nothing claimed after the response');
    assert.equal(refref.requests.length, 0);
    assert.deepEqual(logs.lines.map((l) => JSON.parse(l)), [{ event: 'arrival_ignored', profile: 'NATIVE_NO_REFERRAL' }]);
    for (const line of logs.lines) assert.ok(!line.includes(proof), 'no proof in logs');
  });

  test('missing, malformed, repeated or second arrivals with an old context cookie are inert too', async () => {
    const cookie = oldContext();
    for (const q of ['', 'arrival=short', 'arrival=%3Cscript%3E'.padEnd(60, 'x'), `arrival=${vnext.issue()}&arrival=${vnext.issue()}`,
      `arrival=${vnext.issue()}`]) {
      for (const c of [undefined, cookie]) {
        const r = await http('GET', `/arrive?${q}&to=/tours/`, c ? { cookie: c } : {});
        assert.equal(r.status, 302, q);
        assert.equal(r.location, `${SITE}/tours/`);
        assert.deepEqual(r.setCookie, [], `${q} ${c ?? ''}`);
      }
    }
    await settle();
    assert.equal(vnext.hits, 0);
    assert.equal(refref.requests.length, 0);
  });

  test('later requests of the same browser — the form, Buy, the order page — never deliver an earlier arrival', async () => {
    const cookie = oldContext();
    await http('GET', `/arrive?arrival=${vnext.issue()}&to=/`, { cookie });
    const form = await http('GET', '/book?departure=altai-2026-11-01', { cookie });
    assert.equal(form.status, 200);
    assert.deepEqual(form.setCookie, [], 'the form issues no context');
    const buy = await http('POST', '/orders', { cookie, form: bookingForm() });
    assert.equal(buy.status, 303, buy.body);
    assert.equal(buy.setCookie.length, 1);
    assert.match(buy.setCookie[0]!, /^__Host-mk_mk-[0-9a-z]{12}=/, 'only the order state cookie');
    const ref = new URL(buy.location!).searchParams.get('merchantOrderRef')!;
    await http('GET', `/orders/${ref}`, { cookie: `${cookie}; ${buy.setCookie[0]!.split(';')[0]}` });
    clock = new Date(clock.getTime() + 60_000);
    await http('GET', '/book?departure=altai-2026-11-01', { cookie });
    await settle();
    assert.equal(vnext.hits, 0);
  });
});

describe('the order form', () => {
  test('shows the promo code and Apply disabled with the reason; nothing can submit or enable them', async () => {
    const r = await http('GET', '/book?departure=altai-2026-11-01');
    assert.equal(r.status, 200);
    const promo = /<fieldset class="promo">[\s\S]*?<\/fieldset>/.exec(r.body)?.[0];
    assert.ok(promo, 'the promo block is visible');
    const input = /<input [^>]*>/.exec(promo)![0];
    assert.match(input, / disabled[ >]/);
    assert.match(input, /aria-describedby="promo-unavailable"/);
    assert.doesNotMatch(input, /\bname=/, 'a disabled, unnamed input is never submitted');
    const apply = /<button [^>]*>Применить<\/button>/.exec(promo)?.[0];
    assert.ok(apply, 'Apply is visible');
    assert.match(apply, /type="button"/);
    assert.match(apply, / disabled[ >]/);
    assert.match(apply, /aria-describedby="promo-unavailable"/);
    assert.match(promo, /<p id="promo-unavailable"[^>]*>Промокоды при онлайн-бронировании не принимаются/);
    assert.doesNotMatch(promo, /скидк|партн|бонус|позже|начисл/i, 'no discount, partner credit or later application is promised');
    assert.equal((r.body.match(/<button type="submit">/g) ?? []).length, 1, 'the only submit is the booking itself');
    assert.doesNotMatch(r.body, /<script|\son[a-z]+=/i, 'no script, no inline handler');
    assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
    assert.doesNotMatch(String(r.headers['content-security-policy']), /script-src/);
  });

  test('the same order with and without promo, query, autofill and arrival values: same price, terms and Refref traffic', async () => {
    const run = async (path: string, form: Record<string, string>) => {
      refref.reset();
      const booked = await http('POST', path, { form });
      assert.equal(booked.status, 303, booked.body);
      const handoff = new URL(booked.location!);
      const ref = handoff.searchParams.get('merchantOrderRef')!;
      const cookie = booked.setCookie[0]!.split(';')[0]!;
      const back = await http('GET', `/return?rt=${'t'.repeat(40)}&state=${handoff.searchParams.get('state')}`, { cookie });
      assert.equal(back.status, 303, back.body);
      const page = await http('GET', `/orders/${ref}`, { cookie });
      const row = (await db.owner.query(`SELECT status, seats, amount_kopecks, payable_kopecks, discount_kopecks, departure_slug,
        legal_release_ref, pd_consent_ref FROM orders WHERE order_ref = $1`, [ref])).rows[0];
      const traffic = refref.requests.map((q) => `${q.method} ${q.path.replace(ref, '<ref>')}`);
      const sent = JSON.stringify(refref.requests);
      return { row, traffic, sent, handoffKeys: [...handoff.searchParams.keys()].sort(), total: /Итого к оплате: [^<]*/.exec(page.body)?.[0] };
    };
    const plain = await run('/orders', bookingForm('one@example.ru'));
    const noisy = await run(`/orders?${new URLSearchParams(PROMO_NOISE)}`, { ...bookingForm('two@example.ru'), ...PROMO_NOISE });
    assert.deepEqual(noisy.row, plain.row);
    assert.equal(noisy.row.discount_kopecks, '0');
    assert.ok(plain.total && noisy.total === plain.total, `${plain.total} / ${noisy.total}`);
    assert.deepEqual(noisy.traffic, plain.traffic, 'no extra Refref call');
    assert.deepEqual(noisy.handoffKeys, plain.handoffKeys);
    for (const v of ['FRIEND50', 'partner-1', PROMO_NOISE.arrival]) assert.ok(!noisy.sent.includes(v), `not sent to Refref: ${v}`);
    assert.equal(vnext.hits, 0);
  });
});

/** A legacy order (Refref RC owner) taken to PAYMENT_PENDING through the existing flow. */
async function legacyPendingOrder(departure?: string): Promise<{ ref: string; cookie: string }> {
  const booked = await http('POST', '/orders', { form: bookingForm(undefined, departure) });
  const handoff = new URL(booked.location!);
  const ref = handoff.searchParams.get('merchantOrderRef')!;
  const cookie = booked.setCookie[0]!.split(';')[0]!;
  await http('GET', `/return?rt=${'t'.repeat(40)}&state=${handoff.searchParams.get('state')}`, { cookie });
  const { rows } = await db.owner.query(`SELECT d.sha256 FROM order_document d JOIN orders o ON o.id = d.order_id
    WHERE o.order_ref = $1`, [ref]);
  const paid = await http('POST', `/orders/${ref}/pay`, { cookie, form: { zayavka: rows[0].sha256 } });
  assert.equal(paid.location, 'https://pay.alfa.example/form?mdOrder=1');
  assert.equal((await db.owner.query('SELECT status FROM orders WHERE order_ref = $1', [ref])).rows[0].status, 'PAYMENT_PENDING');
  return { ref, cookie };
}

const legacyReadBacks = () => refref.calls(/^\/integrations\/orders\/[^/]+\/checkout-attempts\/[^/]+$/, 'GET').length;

test('legacy read-back of an existing order stays available and is counted apart from native ingress', async () => {
  const { ref, cookie } = await legacyPendingOrder();
  refref.reset();
  await http('GET', `/arrive?arrival=${vnext.issue()}&to=/`, { cookie });
  const page = await http('GET', `/orders/${ref}`, { cookie });
  assert.match(page.body, /Проверяем платёж/);
  assert.equal(legacyReadBacks(), 1, 'the legacy owner is read back');
  assert.equal(refref.requests.length, 1, 'and nothing else is sent to Refref');
  await settle();
  assert.equal(vnext.hits, 0);
});

describe('the real entrypoint with REFREF_VNEXT_API_BASE populated', () => {
  const freePort = async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    return port;
  };

  /** Start src/bin/serve.ts, run `body` against it, then SIGTERM and wait for a clean exit. */
  async function withService(body: (base: string, output: () => string) => Promise<void>): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'commerce-native-'));
    const identity = join(dir, 'identity.json');
    writeFileSync(identity, JSON.stringify({ schema: 1, service: 'mikluha-commerce', sourceCommit: 'a'.repeat(40) }));
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin/serve.ts'], {
      cwd: join(MIGRATIONS_DIR, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COMMERCE_ENVIRONMENT: 'STAGING', CONTENT_DIR: join(MIGRATIONS_DIR, '..', '..', 'content'),
        BUILD_IDENTITY_FILE: identity, DATABASE_URL: String(db.pool.options.connectionString), PORT: String(port),
        COMMERCE_ORIGIN: COMMERCE, SITE_ORIGIN: SITE, REFREF_API_BASE: refref.base,
        REFREF_CHECKOUT_ORIGIN: 'https://checkout.refref.example', REFREF_VNEXT_API_BASE: vnext.base,
        REFREF_BUSINESS_ID: MERCHANT_ID, REFREF_BUSINESS_SLUG: 'mikluha', REFREF_API_KEY: '',
        NOTISEND_API_KEY: 'ns_test', NOTISEND_FROM_EMAIL: 'noreply@mikluha.example', NOTISEND_FROM_NAME: 'Миклуха' },
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { out += c; });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    try {
      const deadline = Date.now() + 15_000;
      while (!out.includes('"event":"listening"')) {
        if (Date.now() > deadline || child.exitCode !== null) assert.fail(`service did not start:\n${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await body(`http://127.0.0.1:${port}`, () => out);
    } finally {
      child.kill('SIGTERM');
    }
    assert.equal(await exited, 0, out);
    return out;
  }

  test('retired routes cannot claim, reserve, pay or reconcile, including across restart', async () => {
    clock = new Date();
    await legacyPendingOrder('altai-2099-06-01');
    const earlier = refref.requests.length;
    const cookie = oldContext();
    const proofs = [vnext.issue(), vnext.issue()];
    for (const proof of proofs) {
      const out = await withService(async (svc) => {
        for (const [method, path] of [['GET', `/arrive?arrival=${proof}&to=/tours/`],
          ['GET', '/book?departure=altai-1'], ['POST', '/orders'], ['POST', '/orders/old/pay'],
          ['GET', '/return?rt=secret'], ['GET', '/orders/old']]) {
          const r = await http(method!, path!, { cookie, base: svc });
          assert.equal(r.status, 410, `${method} ${path}`);
          assert.equal(r.location, undefined);
          assert.deepEqual(r.setCookie, []);
        }
        await settle();
      });
      const listening = out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.event === 'listening')!;
      assert.equal(listening.ingress, 'NATIVE_NO_REFERRAL');
      assert.equal(listening.sales, 'CLOSED');
      assert.ok(!out.includes(proof));
    }
    assert.equal(vnext.hits, 0);
    assert.equal(refref.requests.length, earlier, 'no legacy read-back worker or client');
  });
});
