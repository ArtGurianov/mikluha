// The isolated Admin API over HTTP (ART-363): password + TOTP login, enrolment, replay and the ±1
// step window, sessions (refresh, logout, idle and absolute expiry, revocation), same-origin writes,
// the throttle, OWNER-only publishing, the SSH reset path and the audit it leaves.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import { ADMIN_SERVICE, assertAdminEnvironment, createAdminServer, adminOrigin, SESSION_COOKIE } from '../src/admin/api.js';
import { GlobalLoginLimit, pruneLoginThrottle, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, THROTTLE_SOURCE_LIMIT, THROTTLE_ACCOUNT_LIMIT } from '../src/admin/auth.js';
import { clearThrottle, createUser, resetTotp, revokeSessions, setDisabled } from '../src/admin/operator.js';
import { base32Decode, hotp, totpStep, TOTP_STEP_SECONDS } from '../src/admin/totp.js';
import type { Catalog } from '../src/catalog.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { schemaHead } from '../src/migrate.js';
import type { CheckoutDeps } from '../src/checkout.js';
import { reserve, setSalesOpen } from '../src/orders.js';
import { createCommerceServer } from '../src/server.js';
import { createWebHandler } from '../src/web.js';
import pg from 'pg';

import { fixtureCatalog, freshDb, tourist, type TestDb } from './helpers.js';

const ORIGIN = 'https://admin.mikluha.test';
const HOST = 'admin.mikluha.test';
const PASSWORD = 'correct horse battery staple';
const KEY = Buffer.alloc(32, 11);

let db: TestDb;
let server: Server;
let port: number;
let clock: Date;
let ipCounter = 0;
let catalog: Catalog;

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: 'altai-admin', startsOn: '2027-07-01', endsOn: '2027-07-04', price: 30000 }]);
  clock = new Date();
  server = createAdminServer({ pool: db.admin, publisherPool: db.publisher, totpKey: KEY, auditKeys: { id: 'audit-1', key: Buffer.alloc(32, 12) }, origin: ORIGIN, schemaHead: schemaHead(MIGRATIONS_DIR),
    sourceCommit: null, startedAt: new Date(), log: () => undefined, now: () => clock });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await db.drop();
});

interface Res { status: number; body: Record<string, unknown>; cookie: string | undefined; setCookie: string | undefined; headers: Record<string, unknown> }

/** A fresh client address per call unless one is given, so only the tests about it meet the throttle. */
function call(method: string, path: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string>; ip?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { host: HOST, 'x-forwarded-for': opts.ip ?? `203.0.113.${(ipCounter++ % 250) + 1}` };
  if (method !== 'GET') { headers.origin = ORIGIN; headers['content-type'] = 'application/json'; headers['sec-fetch-site'] = 'same-origin'; }
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  Object.assign(headers, opts.headers);
  for (const [k, v] of Object.entries(headers)) if (v === '') delete headers[k];
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { raw += c; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie']?.[0];
        const cookie = setCookie?.match(new RegExp(`^${SESSION_COOKIE}=([^;]*)`))?.[1] || undefined;
        resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : {}, cookie, setCookie, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  });
}

const tick = (seconds: number) => { clock = new Date(clock.getTime() + seconds * 1000); };
const code = (seed: Buffer, offsetSteps = 0) => hotp(seed, totpStep(clock) + offsetSteps);

/** An account created by the operator and enrolled through the API, as the owner would. */
async function enrolled(login: string, role: 'OWNER' | 'EDITOR' = 'OWNER'): Promise<{ seed: Buffer; cookie: string }> {
  await createUser(db.adminOperator, login, role, PASSWORD, 'art');
  const started = await call('POST', '/api/auth/enroll', { body: { login, password: PASSWORD } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const seed = base32Decode(started.body.secret as string);
  const confirmed = await call('POST', '/api/auth/enroll/confirm', { body: { login, password: PASSWORD, code: code(seed) } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  tick(TOTP_STEP_SECONDS);
  return { seed, cookie: confirmed.cookie! };
}

async function login(login: string, seed: Buffer): Promise<string> {
  const r = await call('POST', '/api/auth/login', { body: { login, password: PASSWORD, code: code(seed) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  tick(TOTP_STEP_SECONDS);
  return r.cookie!;
}

const auditRows = async (action: string) => (await db.owner.query(
  'SELECT actor, outcome, login_role, details FROM admin_audit WHERE action = $1 ORDER BY id', [action])).rows;

describe('login with password and TOTP', () => {
  test('enrolment: QR secret, first code confirms, then never again from the web', async () => {
    await createUser(db.adminOperator, 'enrol-owner', 'OWNER', PASSWORD, 'art');
    let r = await call('POST', '/api/auth/login', { body: { login: 'enrol-owner', password: PASSWORD, code: '000000' } });
    assert.deepEqual([r.status, r.body.error], [403, 'TOTP_ENROLLMENT_REQUIRED']);
    r = await call('POST', '/api/auth/enroll', { body: { login: 'enrol-owner', password: 'wrong password!!' } });
    assert.deepEqual([r.status, r.body.error], [401, 'INVALID_CREDENTIALS']);

    const started = await call('POST', '/api/auth/enroll', { body: { login: 'enrol-owner', password: PASSWORD } });
    assert.equal(started.status, 200);
    assert.match(started.body.otpauthUri as string, /^otpauth:\/\/totp\/Mikluha%3Aenrol-owner\?secret=[A-Z2-7]{32}&issuer=Mikluha&algorithm=SHA1&digits=6&period=30$/);
    const seed = base32Decode(started.body.secret as string);
    const stored = (await db.owner.query("SELECT seed_ciphertext FROM admin_totp t JOIN admin_user u ON u.id = t.admin_id WHERE login = 'enrol-owner'")).rows[0];
    assert.ok(!JSON.stringify(stored).includes(started.body.secret as string), 'the seed is stored only encrypted');

    r = await call('POST', '/api/auth/enroll/confirm', { body: { login: 'enrol-owner', password: PASSWORD, code: code(seed, 3) } });
    assert.deepEqual([r.status, r.body.error], [401, 'INVALID_CREDENTIALS']);
    r = await call('POST', '/api/auth/enroll/confirm', { body: { login: 'enrol-owner', password: PASSWORD, code: code(seed) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.role, 'OWNER');
    assert.match(r.setCookie!, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$`));

    // Enrolled: a second QR code would let a password thief bind their own device.
    r = await call('POST', '/api/auth/enroll', { body: { login: 'enrol-owner', password: PASSWORD } });
    assert.deepEqual([r.status, r.body.error], [409, 'TOTP_ALREADY_ENROLLED']);
    assert.equal((await db.owner.query("SELECT totp_enrollment_until FROM admin_user WHERE login = 'enrol-owner'")).rows[0].totp_enrollment_until, null);
  });

  test('a code is spent once: the same code, or an earlier one, is refused within its step', async () => {
    const { seed } = await enrolled('replay-owner');
    const used = code(seed);
    assert.equal((await call('POST', '/api/auth/login', { body: { login: 'replay-owner', password: PASSWORD, code: used } })).status, 200);
    const again = await call('POST', '/api/auth/login', { body: { login: 'replay-owner', password: PASSWORD, code: used } });
    assert.deepEqual([again.status, again.body.error], [401, 'INVALID_CREDENTIALS']);
    const earlier = await call('POST', '/api/auth/login', { body: { login: 'replay-owner', password: PASSWORD, code: code(seed, -1) } });
    assert.equal(earlier.status, 401);
    // Two concurrent requests with one fresh code: exactly one session.
    tick(TOTP_STEP_SECONDS);
    const fresh = code(seed);
    const both = await Promise.all([1, 2].map(() => call('POST', '/api/auth/login', { body: { login: 'replay-owner', password: PASSWORD, code: fresh } })));
    assert.deepEqual(both.map(r => r.status).sort(), [200, 401]);
    assert.ok((await auditRows('AUTH.LOGIN')).some(r => r.actor === 'replay-owner' && r.outcome === 'REFUSED' && r.details.reason === 'CODE_REUSED'));
  });

  test('a code one step either side is accepted; two steps away is refused', async () => {
    const { seed } = await enrolled('window-owner');
    tick(2 * TOTP_STEP_SECONDS);
    for (const offset of [2, -2, 5]) {
      const r = await call('POST', '/api/auth/login', { body: { login: 'window-owner', password: PASSWORD, code: code(seed, offset) } });
      assert.equal(r.status, 401, `offset ${offset}`);
    }
    assert.equal((await call('POST', '/api/auth/login', { body: { login: 'window-owner', password: PASSWORD, code: code(seed, -1) } })).status, 200);
    assert.equal((await call('POST', '/api/auth/login', { body: { login: 'window-owner', password: PASSWORD, code: code(seed, 1) } })).status, 200);
  });

  test('a wrong password, an unknown login and a disabled account all answer the same', async () => {
    const { seed } = await enrolled('disabled-owner');
    const answers = await Promise.all([
      call('POST', '/api/auth/login', { body: { login: 'disabled-owner', password: 'not the password', code: code(seed) } }),
      call('POST', '/api/auth/login', { body: { login: 'nobody-here', password: PASSWORD, code: code(seed) } }),
    ]);
    assert.deepEqual(answers.map(a => [a.status, a.body.error]), [[401, 'INVALID_CREDENTIALS'], [401, 'INVALID_CREDENTIALS']]);
    await setDisabled(db.adminOperator, 'disabled-owner', true, 'art', 'left the project');
    tick(TOTP_STEP_SECONDS);
    const r = await call('POST', '/api/auth/login', { body: { login: 'disabled-owner', password: PASSWORD, code: code(seed) } });
    assert.deepEqual([r.status, r.body.error], [401, 'INVALID_CREDENTIALS']);
  });
});

describe('sessions', () => {
  test('session, refresh rotates the token, logout revokes it', async () => {
    const { seed } = await enrolled('session-owner');
    const first = await login('session-owner', seed);
    const s = await call('GET', '/api/auth/session', { cookie: first });
    assert.deepEqual([s.status, s.body.login, s.body.role], [200, 'session-owner', 'OWNER']);

    const refreshed = await call('POST', '/api/auth/refresh', { cookie: first, body: {} });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.cookie, first);
    assert.equal(refreshed.body.absoluteExpiresAt, s.body.absoluteExpiresAt, 'a refresh never extends the session past 12 hours');
    assert.equal((await call('GET', '/api/auth/session', { cookie: first })).status, 401);
    assert.equal((await call('GET', '/api/auth/session', { cookie: refreshed.cookie! })).status, 200);

    const out = await call('POST', '/api/auth/logout', { cookie: refreshed.cookie!, body: {} });
    assert.equal(out.status, 200);
    assert.match(out.setCookie!, /Max-Age=0/);
    assert.equal((await call('GET', '/api/auth/session', { cookie: refreshed.cookie! })).status, 401);
    const reasons = (await db.owner.query(`SELECT revoked_reason FROM admin_session s JOIN admin_user u ON u.id = s.admin_id
      WHERE login = 'session-owner' AND revoked_at IS NOT NULL ORDER BY s.created_at`)).rows.map(r => r.revoked_reason);
    assert.deepEqual(reasons.slice(-2), ['REFRESH', 'LOGOUT']);
  });

  test('idle for 30 minutes, or 12 hours in all, and the session is over', async () => {
    const { seed } = await enrolled('expiry-owner');
    let cookie = await login('expiry-owner', seed);
    tick(SESSION_IDLE_MS / 1000 + 1);
    assert.equal((await call('GET', '/api/auth/session', { cookie })).status, 401);

    tick(TOTP_STEP_SECONDS);
    cookie = await login('expiry-owner', seed);
    for (let t = 0; t < SESSION_ABSOLUTE_MS - 20 * 60_000; t += 20 * 60_000) {
      tick(20 * 60);
      assert.equal((await call('GET', '/api/auth/session', { cookie })).status, 200, `at ${t / 60_000} min`);
    }
    tick(20 * 60);
    assert.equal((await call('GET', '/api/auth/session', { cookie })).status, 401);
  });

  test('another session of mine can be revoked; somebody else\'s cannot', async () => {
    const { seed } = await enrolled('multi-owner');
    const a = await login('multi-owner', seed);
    const b = await login('multi-owner', seed);
    const list = await call('GET', '/api/auth/sessions', { cookie: a });
    const other = (list.body.sessions as { id: string }[]).find(s => s.id !== list.body.current)!;
    const intruder = await enrolled('multi-other');
    assert.equal((await call('POST', '/api/auth/sessions/revoke', { cookie: intruder.cookie, body: { sessionId: other.id } })).status, 404);
    assert.equal((await call('POST', '/api/auth/sessions/revoke', { cookie: a, body: { sessionId: other.id } })).status, 200);
    assert.equal((await call('GET', '/api/auth/session', { cookie: b })).status, 401);
    assert.equal((await call('GET', '/api/auth/session', { cookie: a })).status, 200);
  });
});

describe('the boundary', () => {
  test('writes only from the admin origin, as JSON; requests for another host are refused', async () => {
    const body = { login: 'x-owner', password: PASSWORD, code: '123456' };
    const refused = await Promise.all([
      call('POST', '/api/auth/login', { body, headers: { origin: '' } }),
      call('POST', '/api/auth/login', { body, headers: { origin: 'https://evil.example' } }),
      call('POST', '/api/auth/login', { body, headers: { origin: 'https://book.mikluha-maklai.ru' } }),
      call('POST', '/api/auth/login', { body, headers: { 'sec-fetch-site': 'cross-site' } }),
      call('POST', '/api/auth/login', { body: 'login=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    ]);
    assert.deepEqual(refused.map(r => r.status), [403, 403, 403, 403, 415]);
    for (const h of ['book.mikluha-maklai.ru', 'mikluha-maklai.ru', `127.0.0.1:${port}`]) {
      assert.equal((await call('POST', '/api/auth/login', { body, headers: { host: h } })).status, 421, h);
    }
    const health = await call('GET', '/readyz', { headers: { host: `127.0.0.1:${port}` } });
    assert.deepEqual([health.status, health.body.service, health.body.status], [200, ADMIN_SERVICE, 'READY']);
    assert.equal((await call('GET', '/', {})).status, 404, 'the API serves no pages: the Control Room is static');
  });

  test('unauthenticated and wrong-role writes are refused; publishing is the OWNER\'s', async () => {
    const owner = await enrolled('pub-owner');
    const editor = await enrolled('pub-editor', 'EDITOR');
    assert.equal((await call('POST', '/api/tours', { body: { slug: 'anon-tour' } })).status, 401);
    assert.equal((await call('GET', '/api/tours')).status, 401);

    const created = await call('POST', '/api/tours', { cookie: editor.cookie, body: { slug: 'altai-tour' } });
    assert.equal(created.status, 201);
    const id = created.body.id as string;
    const doc = { slug: 'altai-tour', title: 'Алтай', contract: null, content: { summary: 'Тур' } };
    assert.equal((await call('PUT', `/api/tours/${id}/draft`, { cookie: editor.cookie, body: { expectedRevision: 0, document: doc } })).status, 200);
    const denied = await call('POST', `/api/tours/${id}/publish`, { cookie: editor.cookie, body: { expectedDraftRevision: 1, expectedPublishedVersion: 0 } });
    assert.deepEqual([denied.status, denied.body.error], [403, 'FORBIDDEN']);
    assert.equal((await db.owner.query('SELECT published_version FROM tour WHERE id = $1', [id])).rows[0].published_version, null);

    const ok = await call('POST', `/api/tours/${id}/publish`, { cookie: owner.cookie, body: { expectedDraftRevision: 1, expectedPublishedVersion: 0 } });
    assert.deepEqual([ok.status, ok.body.version], [200, 1]);
    const stale = await call('POST', `/api/tours/${id}/publish`, { cookie: owner.cookie, body: { expectedDraftRevision: 1, expectedPublishedVersion: 0 } });
    assert.deepEqual([stale.status, stale.body.error], [409, 'PUBLISHED_VERSION_CONFLICT']);
    const rev = (await db.owner.query('SELECT published_by, login_role FROM tour_revision WHERE tour_id = $1', [id])).rows[0];
    assert.deepEqual(rev, { published_by: 'admin:pub-owner', login_role: 'commerce_test_admin_publisher' });

    assert.equal((await call('GET', '/api/audit', { cookie: editor.cookie })).status, 403);
    const log = await call('GET', '/api/audit', { cookie: owner.cookie });
    assert.equal(log.status, 200);
    const actions = (log.body.entries as { action: string; actor: string; outcome: string }[]).map(e => `${e.action}:${e.actor}:${e.outcome}`);
    assert.ok(actions.includes('TOUR.PUBLISHED:pub-owner:OK'));
    assert.ok(actions.includes('PERMISSION.DENIED:pub-editor:REFUSED'));
    assert.ok(!JSON.stringify(log.body).includes(PASSWORD));
  });

  test('publishing and classification: OWNER only, from the live session, linked to its login', async () => {
    const owner = await enrolled('exec-owner');
    const editor = await enrolled('exec-editor', 'EDITOR');
    const tour = (await call('POST', '/api/tours', { cookie: owner.cookie, body: { slug: 'exec-tour' } })).body.id as string;
    await call('PUT', `/api/tours/${tour}/draft`, { cookie: owner.cookie,
      body: { expectedRevision: 0, document: { slug: 'exec-tour', title: 'Алтай', contract: null, content: {} } } });
    assert.equal((await call('POST', `/api/tours/${tour}/publish`, { cookie: owner.cookie, body: { expectedDraftRevision: 1, expectedPublishedVersion: 0 } })).status, 200);
    const dep = (await call('POST', '/api/departures', { cookie: editor.cookie, body: { slug: 'altai-admin', tourId: tour } })).body.id as string;
    const { tour: t, departure: { departureTime: _d, returnTime: _r, ...d } } = catalog.departures.get('altai-admin')!.contract!;
    const doc = { slug: 'altai-admin', startsOn: '2027-07-01', endsOn: '2027-07-04', departureTime: '06:00', returnTime: '21:00',
      timezone: 'Asia/Krasnoyarsk', priceKopecks: 3_000_000, contract: { tour: t, departure: d }, content: {} };
    const save = (rev: number, document: unknown) => call('PUT', `/api/departures/${dep}/draft`, { cookie: editor.cookie, body: { expectedRevision: rev, document } });
    const pub = (cookie: string | undefined, draft: number, version: number, extra: Record<string, unknown> = {}) =>
      call('POST', `/api/departures/${dep}/publish`, { ...(cookie ? { cookie } : {}),
        body: { expectedDraftRevision: draft, expectedPublishedVersion: version, ...extra } });
    // A new departure starts with draft revision 1 (the tour template, ART-358).
    assert.equal((await save(1, doc)).status, 200);
    assert.deepEqual((await pub(owner.cookie, 2, 0)).body, { outcome: 'PUBLISHED', version: 1, changeId: null, affectedOrders: 0 });

    await db.owner.query("UPDATE departure SET booking_status='OPEN',is_listed=true,capacity=12 WHERE id=$1", [dep]);
    await db.owner.query('UPDATE tour SET is_listed=true WHERE id=$1', [tour]);
    await setSalesOpen(db.operator, true, 'test', 'an order for the classification');
    const r = await reserve({ pool: db.pool, catalog, log: () => undefined, allowDemo: false, now: () => new Date() }, {
      departureSlug: 'altai-admin', contact: { phone: '+79039075547', email: 'ivan@example.ru' }, passengers: [tourist(1)],
      adultsOnlyConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash, pdConsentConfirmed: true,
      pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash });
    assert.ok(r.ok);

    assert.equal((await save(2, { ...doc, contract: { tour: { ...t, route: 'Другой маршрут' }, departure: d } })).status, 200);
    const unclassified = await pub(owner.cookie, 3, 1);
    assert.deepEqual([unclassified.status, unclassified.body.error], [409, 'EXECUTION_CHANGE_CLASSIFICATION_REQUIRED']);
    const change = { classification: 'EQUIVALENT', notice: 'Маршрут заменён равноценным.', by: 'owner' };
    // Naming the owner in the request is worth nothing: no session, a revoked one, or an editor's.
    assert.equal((await pub(undefined, 3, 1, change)).status, 401);
    const second = await login('exec-owner', owner.seed);
    await call('POST', '/api/auth/logout', { cookie: second, body: {} });
    assert.equal((await pub(second, 3, 1, change)).status, 401);
    assert.deepEqual((await pub(editor.cookie, 3, 1, change)).body, { error: 'FORBIDDEN' });

    const listed = await call('GET', `/api/departures/${dep}/affected-orders`, { cookie: editor.cookie });
    assert.deepEqual(listed.body.orders, [{ orderRef: r.ok ? r.orderRef : '', status: 'RESERVED' }]);
    const applied = await pub(owner.cookie, 3, 1, change);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual([applied.body.outcome, applied.body.version, applied.body.affectedOrders], ['APPLIED', 2, 1]);
    const changeId = applied.body.changeId as string;
    const recorded = (await db.owner.query('SELECT classified_by, login_role FROM departure_execution_change WHERE id = $1', [changeId])).rows[0];
    assert.deepEqual(recorded, { classified_by: 'admin:exec-owner', login_role: 'commerce_test_admin_publisher' });
    // The Admin audit of the classification names the session and the password + TOTP login behind it.
    const link = (await db.owner.query(`SELECT a.actor, l.action AS auth_action, l.actor AS auth_actor, l.entity_id = a.details->>'sessionId' AS same_session
      FROM admin_audit a JOIN admin_audit l ON l.id = (a.details->>'authAuditId')::bigint
      WHERE a.action = 'DEPARTURE.EXECUTION_CHANGE_EQUIVALENT' AND a.details->>'changeId' = $1`, [changeId])).rows;
    assert.deepEqual(link, [{ actor: 'exec-owner', auth_action: 'AUTH.LOGIN', auth_actor: 'exec-owner', same_session: true }]);
    const notices = await call('GET', `/api/changes/${changeId}/notices`, { cookie: editor.cookie });
    assert.deepEqual((notices.body.notices as { state: string }[]).map(n => n.state), ['PENDING']);

    // A price is edited freely; it reaches new quotes only.
    assert.equal((await save(3, { ...doc, contract: { tour: { ...t, route: 'Другой маршрут' }, departure: d }, priceKopecks: 3_200_000 })).status, 200);
    assert.deepEqual((await pub(owner.cookie, 4, 2)).body, { outcome: 'PUBLISHED', version: 3, changeId: null, affectedOrders: 0 });
  });

  test('content and legal items are created by editors and published by the OWNER', async () => {
    const owner = await enrolled('content-owner');
    const editor = await enrolled('content-editor', 'EDITOR');
    const created = await call('POST', '/api/content', { cookie: editor.cookie, body: { kind: 'organizer', slug: 'artur' } });
    assert.equal(created.status, 201);
    const id = created.body.id as string;
    const doc = { slug: 'artur', name: 'Артур', isListed: false, isDemo: false, content: {} };
    assert.equal((await call('PUT', `/api/content/${id}/draft`, { cookie: editor.cookie, body: { expectedRevision: 0, document: doc } })).status, 200);
    const body = { expectedDraftRevision: 1, expectedPublishedVersion: 0 };
    assert.equal((await call('POST', `/api/content/${id}/publish`, { cookie: editor.cookie, body })).status, 403);
    assert.deepEqual((await call('POST', `/api/content/${id}/publish`, { cookie: owner.cookie, body })).body,
      { outcome: 'PUBLISHED', version: 1, changeId: null, affectedOrders: 0 });
    assert.equal((await call('POST', '/api/content', { cookie: editor.cookie, body: { kind: 'secret', slug: 'x' } })).status, 422);
    const list = await call('GET', '/api/content', { cookie: editor.cookie });
    assert.ok((list.body.items as { slug: string }[]).some(i => i.slug === 'artur'));
  });

  test('the throttle counts password and code attempts together, per source and per account', async () => {
    const { seed } = await enrolled('throttle-owner');
    const ip = '198.51.100.7';
    for (let i = 0; i < THROTTLE_SOURCE_LIMIT; i++) {
      const r = await call('POST', '/api/auth/login', { ip, body: { login: 'throttle-owner', password: i % 2 ? 'wrong wrong wrong' : PASSWORD, code: '000000' } });
      assert.equal(r.status, 401);
    }
    const limited = await call('POST', '/api/auth/login', { ip, body: { login: 'throttle-owner', password: PASSWORD, code: code(seed) } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    // Spread over many sources, one account still meets its own limit.
    for (let i = 0; i < THROTTLE_ACCOUNT_LIMIT; i++) await call('POST', '/api/auth/login', { body: { login: 'throttle-owner', password: 'x', code: '000000' } });
    assert.equal((await call('POST', '/api/auth/login', { body: { login: 'throttle-owner', password: PASSWORD, code: code(seed) } })).status, 429);
    const stored = (await db.owner.query('SELECT bucket FROM admin_login_throttle')).rows.map(r => r.bucket).join(' ');
    assert.ok(!stored.includes(ip) && !stored.includes('throttle-owner'), 'only keyed hashes are stored');

    await clearThrottle(db.adminOperator, 'art', 'locked out by a test');
    assert.equal((await call('POST', '/api/auth/login', { ip, body: { login: 'throttle-owner', password: PASSWORD, code: code(seed) } })).status, 200);
  });
});

describe('lost device: the operator CLI reset over SSH', () => {
  test('revokes every session, forces re-enrolment with a new seed, and is audited', async () => {
    const { seed, cookie } = await enrolled('lost-owner');
    const other = await login('lost-owner', seed);
    assert.equal(await resetTotp(db.adminOperator, 'lost-owner', 'art', 'phone lost'), 2);
    for (const c of [cookie, other]) assert.equal((await call('GET', '/api/auth/session', { cookie: c })).status, 401);
    const r = await call('POST', '/api/auth/login', { body: { login: 'lost-owner', password: PASSWORD, code: code(seed) } });
    assert.deepEqual([r.status, r.body.error], [403, 'TOTP_ENROLLMENT_REQUIRED']);

    const started = await call('POST', '/api/auth/enroll', { body: { login: 'lost-owner', password: PASSWORD } });
    const fresh = base32Decode(started.body.secret as string);
    assert.notDeepEqual(fresh, seed);
    tick(TOTP_STEP_SECONDS);
    assert.equal((await call('POST', '/api/auth/enroll/confirm', { body: { login: 'lost-owner', password: PASSWORD, code: code(seed) } })).status, 401);
    assert.equal((await call('POST', '/api/auth/enroll/confirm', { body: { login: 'lost-owner', password: PASSWORD, code: code(fresh) } })).status, 200);

    const [row] = (await auditRows('TOTP.RESET')).filter(e => e.details.reason === 'phone lost');
    assert.deepEqual(row, { actor: 'operator:art', outcome: 'OK', login_role: 'commerce_test_admin_operator',
      details: { reason: 'phone lost', hadTotp: true, sessionsRevoked: 2 } });
  });

  test('the enrolment window closes: no QR code for a password alone after 24 hours', async () => {
    await createUser(db.adminOperator, 'late-owner', 'OWNER', PASSWORD, 'art');
    await db.owner.query("UPDATE admin_user SET totp_enrollment_until = now() - interval '1 second' WHERE login = 'late-owner'");
    const r = await call('POST', '/api/auth/enroll', { body: { login: 'late-owner', password: PASSWORD } });
    assert.deepEqual([r.status, r.body.error], [403, 'TOTP_ENROLLMENT_CLOSED']);
  });
});

describe('review of ART-363: what the database credential alone cannot do, and revocation races', () => {
  const tourDoc = (slug: string) => ({ slug, title: 'Алтай', contract: null, content: {} });

  async function draftTour(cookie: string, slug: string): Promise<string> {
    const id = (await call('POST', '/api/tours', { cookie, body: { slug } })).body.id as string;
    assert.equal((await call('PUT', `/api/tours/${id}/draft`, { cookie, body: { expectedRevision: 0, document: tourDoc(slug) } })).status, 200);
    return id;
  }

  test('a session forged with admin_runtime alone is never accepted, and its AUTH.LOGIN is FORGED', async () => {
    const victim = await enrolled('forge-victim');
    const auditor = await enrolled('forge-auditor');
    const tour = await draftTour(auditor.cookie, 'forge-tour');
    // Everything the Admin API's database login can do: open a session for the OWNER with a token of
    // its own choosing and any later step, with no password and no code.
    const token = Buffer.alloc(32, 7).toString('base64url');
    const victimId = (await db.owner.query("SELECT id FROM admin_user WHERE login = 'forge-victim'")).rows[0].id;
    const forged = (await db.admin.query('SELECT * FROM fn_admin_login(gen_random_uuid(), $1, $2, false, $3, now(), 1800, $4, gen_random_uuid(), \'audit-1\')',
      [victimId, totpStep(clock) + 1000, createHash('sha256').update(token).digest('hex'), 'f'.repeat(64)])).rows[0];
    assert.ok(forged, 'the database cannot tell: it opens the row');
    assert.equal((await call('GET', '/api/auth/session', { cookie: token })).status, 401);
    assert.equal((await call('POST', `/api/tours/${tour}/publish`, { cookie: token,
      body: { expectedDraftRevision: 1, expectedPublishedVersion: 0 } })).status, 401);
    assert.equal((await db.owner.query('SELECT published_version FROM tour WHERE id = $1', [tour])).rows[0].published_version, null);

    const log = (await call('GET', '/api/audit', { cookie: auditor.cookie })).body.entries as
      { id: number; action: string; actor: string; entityId: string | null; evidence: string }[];
    const evidence = (pred: (e: (typeof log)[number]) => boolean) => log.filter(pred).map(e => e.evidence);
    assert.deepEqual(evidence(e => e.action === 'AUTH.LOGIN' && e.entityId === forged.out_session_id), ['FORGED']);
    assert.ok(evidence(e => e.action === 'AUTH.LOGIN' && e.actor === 'forge-victim' && e.entityId !== forged.out_session_id)
      .every(v => v === 'ATTESTED'));
    assert.deepEqual([...new Set(evidence(e => e.action === 'USER.CREATED'))], ['OPERATOR']);
    void victim;
  });

  test('a publish names its session and an attested AUTH.LOGIN; a row written by the database alone does not verify', async () => {
    const owner = await enrolled('chain-owner');
    const tour = await draftTour(owner.cookie, 'chain-tour');
    assert.equal((await call('POST', `/api/tours/${tour}/publish`, { cookie: owner.cookie,
      body: { expectedDraftRevision: 1, expectedPublishedVersion: 0 } })).status, 200);
    await db.admin.query(`INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details, attestation, event_id, key_id)
      SELECT admin_id, actor, action, outcome, entity_type, entity_id, details, $2, gen_random_uuid(), key_id FROM admin_audit WHERE action = 'TOUR.PUBLISHED' AND entity_id = $1`,
    [tour, '0'.repeat(64)]);
    // Replaying the actual valid signature with its event identity is rejected by SQL uniqueness.
    await assert.rejects(db.admin.query(`INSERT INTO admin_audit
      (admin_id, actor, action, outcome, entity_type, entity_id, details, attestation, event_id, key_id)
      SELECT admin_id, actor, action, outcome, entity_type, entity_id, details, attestation, event_id, key_id
      FROM admin_audit WHERE action = 'TOUR.PUBLISHED' AND entity_id = $1 AND attestation <> $2`, [tour, '0'.repeat(64)]),
    /duplicate key value/);
    // Changing only the identity cannot rescue the copied valid MAC (nor can its changed DB login).
    await db.admin.query(`INSERT INTO admin_audit
      (admin_id, actor, action, outcome, entity_type, entity_id, details, attestation, event_id, key_id)
      SELECT admin_id, actor, action, outcome, entity_type, entity_id, details, attestation, gen_random_uuid(), key_id
      FROM admin_audit WHERE action = 'TOUR.PUBLISHED' AND entity_id = $1 AND attestation <> $2`, [tour, '0'.repeat(64)]);
    const log = (await call('GET', '/api/audit', { cookie: owner.cookie })).body.entries as
      { action: string; entityId: string | null; evidence: string; details: { authAuditId?: number } }[];
    const published = log.filter(e => e.action === 'TOUR.PUBLISHED' && e.entityId === tour);
    assert.deepEqual(published.map(e => e.evidence).sort(), ['ATTESTED', 'FORGED', 'FORGED']);
    const attested = published.find(e => e.evidence === 'ATTESTED')!;
    const login = (await db.owner.query('SELECT action, actor FROM admin_audit WHERE id = $1', [attested.details.authAuditId])).rows[0];
    assert.deepEqual(login, { action: 'AUTH.LOGIN', actor: 'chain-owner' });
  });

  test('audit history remains attested with verify-only old keys and becomes UNVERIFIABLE if they are lost', async () => {
    const owner = await enrolled('key-history-owner');
    const originalPort = port;
    for (const keep of [true, false]) {
      const previous = keep ? new Map([['audit-1', Buffer.alloc(32, 12)]]) : new Map<string, Buffer>();
      const rotated = createAdminServer({ pool: db.admin, publisherPool: db.publisher, totpKey: KEY,
        auditKeys: { id: 'audit-2', key: Buffer.alloc(32, 13), previous }, origin: ORIGIN, schemaHead: schemaHead(MIGRATIONS_DIR),
        sourceCommit: null, startedAt: new Date(), log: () => undefined, now: () => clock });
      await new Promise<void>(r => rotated.listen(0, '127.0.0.1', r));
      port = (rotated.address() as AddressInfo).port;
      try {
        const log = (await call('GET', '/api/audit', { cookie: owner.cookie })).body.entries as
          { actor: string; action: string; evidence: string }[];
        assert.deepEqual(log.filter(e => e.actor === 'key-history-owner' && e.action === 'AUTH.LOGIN').map(e => e.evidence),
          [keep ? 'ATTESTED' : 'UNVERIFIABLE']);
      } finally {
        port = originalPort;
        rotated.closeAllConnections();
        await new Promise(r => rotated.close(r));
      }
    }
  });

  test('revoked after the permission check but before the publish: the publish is refused', async () => {
    const owner = await enrolled('race-owner');
    const tour = await draftTour(owner.cookie, 'race-tour');
    // Headers now, body later: authorize() runs, then the request waits for its body.
    tick(1);
    const seen = clock.toISOString();
    const pending = new Promise<Res>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: `/api/tours/${tour}/publish`, headers: {
        host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.250',
        cookie: `${SESSION_COOKIE}=${owner.cookie}`, 'transfer-encoding': 'chunked' } }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : {}, cookie: undefined, setCookie: undefined, headers: res.headers }));
      });
      req.on('error', reject);
      req.flushHeaders();
      void (async () => {
        for (let n = 0; n < 200; n++) {
          const r = await db.owner.query(`SELECT s.last_seen_at = $1::timestamptz AS ok FROM admin_session s JOIN admin_user u ON u.id = s.admin_id
            WHERE u.login = 'race-owner' AND s.revoked_at IS NULL ORDER BY s.created_at DESC LIMIT 1`, [seen]);
          if (r.rows[0]?.ok) break;
          await new Promise(res => setTimeout(res, 10));
        }
        await revokeSessions(db.adminOperator, 'race-owner', 'art', 'revoked mid-request');
        req.end(JSON.stringify({ expectedDraftRevision: 1, expectedPublishedVersion: 0 }));
      })().catch(reject);
    });
    const r = await pending;
    assert.deepEqual([r.status, r.body.error], [401, 'UNAUTHENTICATED']);
    assert.equal((await db.owner.query('SELECT published_version FROM tour WHERE id = $1', [tour])).rows[0].published_version, null);
  });

  test('an OWNER session that expires while the account lock is queued cannot publish', async () => {
    const owner = await enrolled('expiry-queued-owner');
    const tour = await draftTour(owner.cookie, 'expiry-queued-tour');
    const initialClock = clock;
    let pending: Promise<Res> | undefined;
    await db.owner.query('BEGIN');
    try {
      await db.owner.query("SELECT id FROM admin_user WHERE login = 'expiry-queued-owner' FOR UPDATE");
      pending = call('POST', `/api/tours/${tour}/publish`, { cookie: owner.cookie,
        body: { expectedDraftRevision: 1, expectedPublishedVersion: 0 } });
      let blocked = false;
      for (let n = 0; n < 200; n++) {
        blocked = (await db.owner.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = $1
          AND usename = 'commerce_test_admin_publisher' AND cardinality(pg_blocking_pids(pid)) > 0) AS ready`, [db.name])).rows[0].ready;
        if (blocked) break;
        await new Promise(r => setTimeout(r, 10));
      }
      assert.ok(blocked, 'publish must have reached its account-lock wait');
      clock = new Date(clock.getTime() + SESSION_ABSOLUTE_MS + 1);
      await db.owner.query('COMMIT');
      const result = await pending;
      assert.deepEqual([result.status, result.body.error], [401, 'UNAUTHENTICATED']);
      assert.equal((await db.owner.query('SELECT published_version FROM tour WHERE id = $1', [tour])).rows[0].published_version, null);
    } finally {
      await db.owner.query('ROLLBACK');
      await pending?.catch(() => undefined);
      clock = initialClock;
    }
  });

  test('a disable that comes while a publish runs waits for it, and the session is gone after', async () => {
    const owner = await enrolled('race-owner2');
    const tour = await draftTour(owner.cookie, 'race-tour2');
    const gate = `race-gate-${tour}`;
    await db.owner.query(`CREATE FUNCTION fn_test_pause_publish() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${gate}', 0)); RETURN NEW; END $f$`);
    await db.owner.query(`CREATE TRIGGER zz_test_pause_publish BEFORE INSERT ON tour_revision
      FOR EACH ROW WHEN (NEW.tour_id = '${tour}') EXECUTE FUNCTION fn_test_pause_publish()`);
    await db.owner.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [gate]);
    const operator = new pg.Client({ connectionString: (() => { const u = new URL(db.url); u.username = 'commerce_test_admin_operator';
      u.password = 'commerce-test-only'; return u.toString(); })() });
    await operator.connect();
    const waitFor = async (sql: string, args: unknown[]) => {
      for (let n = 0; n < 200; n++) {
        if ((await db.owner.query(sql, args)).rows[0].ready) return;
        await new Promise(res => setTimeout(res, 10));
      }
      assert.fail('expected a blocked database operation');
    };
    let publish: Promise<Res> | undefined;
    let disable: Promise<string> | undefined;
    try {
      publish = call('POST', `/api/tours/${tour}/publish`, { cookie: owner.cookie, body: { expectedDraftRevision: 1, expectedPublishedVersion: 0 } });
      await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND usename = 'commerce_test_admin_publisher'
        AND wait_event = 'advisory') AS ready`, [db.name]);
      const operatorPid = (await operator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      disable = operator.query("SELECT fn_admin_set_disabled('race-owner2', true, 'art', 'disabled mid-publish')")
        .then(() => 'DISABLED', (e: Error) => e.message);
      await waitFor('SELECT cardinality(pg_blocking_pids($1)) > 0 AS ready', [operatorPid]);
      await db.owner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [gate]);
      const published = await publish;
      assert.deepEqual([published.status, published.body.version], [200, 1]);
      assert.equal(await disable, 'DISABLED');
      assert.equal((await call('GET', '/api/auth/session', { cookie: owner.cookie })).status, 401);
    } finally {
      await db.owner.query('SELECT pg_advisory_unlock_all()');
      await publish?.catch(() => undefined);
      await disable;
      await operator.end();
      await db.owner.query('DROP TRIGGER zz_test_pause_publish ON tour_revision');
      await db.owner.query('DROP FUNCTION fn_test_pause_publish()');
    }
  });

  test('past the global limit, attempts are refused before the database; spent windows are pruned off the login path', async () => {
    const limited = createAdminServer({ pool: db.admin, publisherPool: db.publisher, totpKey: KEY, auditKeys: { id: 'audit-1', key: Buffer.alloc(32, 12) }, origin: ORIGIN, schemaHead: schemaHead(MIGRATIONS_DIR),
      sourceCommit: null, startedAt: new Date(), log: () => undefined, now: () => clock, loginLimit: new GlobalLoginLimit(2) });
    await new Promise<void>(r => limited.listen(0, '127.0.0.1', r));
    const saved = port;
    port = (limited.address() as AddressInfo).port;
    try {
      const rows = async () => (await db.owner.query('SELECT coalesce(sum(attempts), 0)::int AS n FROM admin_login_throttle')).rows[0].n as number;
      const attempt = () => call('POST', '/api/auth/login', { body: { login: `nobody-${ipCounter}`, password: 'x', code: '000000' } });
      assert.deepEqual([(await attempt()).status, (await attempt()).status], [401, 401]);
      const before = await rows();
      const third = await attempt();
      assert.equal(third.status, 429);
      assert.equal(await rows(), before, 'a refused attempt writes no throttle row');
    } finally {
      port = saved;
      limited.closeAllConnections();
      await new Promise(r => limited.close(r));
    }
    await db.owner.query("INSERT INTO admin_login_throttle VALUES ($1, now() - interval '2 hours', 1)", [`source:${'a'.repeat(64)}`]);
    assert.ok(await pruneLoginThrottle(db.admin, new Date()) >= 1);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM admin_login_throttle WHERE window_start < now() - interval '1 hour'")).rows[0].n, 0);
  });
});

test('book.* is the public service: it serves no Admin route at all', async () => {
  const deps = { pool: db.pool, catalog, log: () => undefined, refref: {} as CheckoutDeps['refref'],
    merchant: { businessId: 'b', businessSlug: 'mikluha', checkoutOrigin: 'https://checkout.example', origin: 'https://book.mikluha-maklai.ru',
      siteOrigin: 'https://mikluha-maklai.ru' } } satisfies CheckoutDeps;
  const commerce = createCommerceServer({ pool: db.pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR), sourceCommit: null,
    startedAt: new Date() }, createWebHandler(deps, false));
  await new Promise<void>(r => commerce.listen(0, '127.0.0.1', r));
  const saved = port;
  port = (commerce.address() as AddressInfo).port;
  try {
    for (const [method, path] of [['POST', '/api/auth/login'], ['POST', '/api/auth/enroll'], ['GET', '/api/auth/session'],
      ['GET', '/api/tours'], ['POST', '/api/tours/00000000-0000-0000-0000-000000000000/publish'], ['GET', '/api/audit']] as const) {
      const r = await call(method, path, { body: method === 'POST' ? {} : undefined, headers: { host: 'book.mikluha-maklai.ru' } });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
  } finally {
    port = saved;
    commerce.closeAllConnections();
    await new Promise(r => commerce.close(r));
  }
});

test('configuration: an https origin only, and no foreign credential in the environment', () => {
  assert.equal(adminOrigin('https://admin.mikluha-maklai.ru'), 'https://admin.mikluha-maklai.ru');
  for (const bad of ['http://admin.mikluha-maklai.ru', 'https://admin.mikluha-maklai.ru/', 'https://a.example/path', 'https://u:p@a.example', 'nonsense']) {
    assert.throws(() => adminOrigin(bad), /ADMIN_ORIGIN/, bad);
  }
  assert.doesNotThrow(() => assertAdminEnvironment({ ADMIN_DATABASE_URL: 'x', ADMIN_TOTP_KEY: 'y', ADMIN_ORIGIN: 'z' }));
  for (const name of ['DATABASE_URL', 'OPERATOR_DATABASE_URL', 'ADMIN_OPERATOR_DATABASE_URL', 'REFREF_API_KEY', 'NOTISEND_API_KEY', 'GITHUB_TOKEN']) {
    assert.throws(() => assertAdminEnvironment({ ADMIN_DATABASE_URL: 'x', [name]: 'secret' }), new RegExp(name));
  }
});
