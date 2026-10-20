// The isolated Admin API (ADR v2.3 §7, Linear ART-363). Its own process and its own database login
// (admin_app), reachable only through the Control Room's same-origin proxy at /api/ — never through
// book.* or the public site. It holds no Refref, Notisend, S3 or GitHub credential.
//
//   GET  /healthz /readyz /identity        container health, internal only
//   POST /api/auth/login                   {login, password, code} → session cookie
//   POST /api/auth/enroll                  {login, password} → otpauth URI, inside the enrolment window
//   POST /api/auth/enroll/confirm          {login, password, code} → first code confirms, session cookie
//   GET  /api/auth/session                 who is signed in (moves the idle expiry)
//   POST /api/auth/refresh                 a new token for the same session lifetime
//   POST /api/auth/logout
//   GET  /api/auth/sessions                this account's live sessions
//   POST /api/auth/sessions/revoke         {sessionId}
//   GET  /api/tours  /api/tours/<id>       editorial read (OWNER, EDITOR)
//   POST /api/tours                        {slug}                        (OWNER, EDITOR)
//   PUT  /api/tours/<id>/draft             {expectedRevision, document}  (OWNER, EDITOR)
//   POST /api/tours/<id>/publish           {expectedDraftRevision, expectedPublishedVersion}  (OWNER)
//   … the same for /api/departures (create takes {slug, tourId})
//   GET  /api/audit?before=<id>            (OWNER)
//
// Session: a __Host- cookie (HttpOnly, Secure, SameSite=Strict, Path=/), 30 minutes idle, 12 hours
// at most. Every state-changing request must come from the admin origin itself (Origin, and
// Sec-Fetch-Site when sent) with a JSON body; a request for another host is refused outright.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type pg from 'pg';

import type { Logger } from '../log.js';
import { BookingRateLimiter } from '../rate-limit.js';
import {
  allowed, audit, consumeLoginAttempt, findAccount, liveSessions, openSession, RateLimited, revokeSession,
  rotateSession, throttleKey, touchSession, type Account, type IssuedSession, type Permission, type Session,
} from './auth.js';
import { UNKNOWN_ACCOUNT_HASH, verifyPassword } from './password.js';
import { decryptSeed, encryptSeed, matchingStep, newSeed } from './totp.js';

export const ADMIN_SERVICE = 'mikluha-admin-api';
export const SESSION_COOKIE = '__Host-mk_admin';
const MAX_AUTH_BODY = 4 * 1024;
const MAX_EDITORIAL_BODY = 320 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AdminDeps {
  readonly pool: pg.Pool;
  readonly totpKey: Buffer;
  /** The Control Room's origin, e.g. https://admin.mikluha-maklai.ru: the only one allowed to write. */
  readonly origin: string;
  readonly schemaHead: number;
  readonly sourceCommit: string | null;
  readonly startedAt: Date;
  readonly log: Logger;
  readonly now?: () => Date;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow',
  'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly headers: Record<string, string> = {}) { super(code); }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { ...HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

const sessionCookie = (token: string, expires: Date, now: Date) =>
  `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1000))}; HttpOnly; Secure; SameSite=Strict`;
const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', (c: string) => { bytes += Buffer.byteLength(c); if (bytes <= limit) raw += c; });
    req.on('end', () => {
      if (bytes > limit) { reject(new HttpError(413, 'BODY_TOO_LARGE')); return; }
      try {
        const v = JSON.parse(raw) as unknown;
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v as Record<string, unknown>);
      } catch { reject(new HttpError(400, 'BODY_INVALID')); }
    });
    req.on('error', reject);
  });
}

const str = (v: unknown, max = 256) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/** Database refusals the editor can act on, by the code the migration raises. */
const DB_CODES: Record<string, number> = {
  DRAFT_REVISION_CONFLICT: 409, PUBLISHED_VERSION_CONFLICT: 409, DEPARTURE_SCHEDULE_LOCKED: 409,
  TOUR_IDENTITY_IMMUTABLE: 409, DEPARTURE_IDENTITY_IMMUTABLE: 409, TOUR_NOT_PUBLISHED: 409,
  TOUR_DOCUMENT_INVALID: 422, DEPARTURE_DOCUMENT_INVALID: 422, TOUR_UNKNOWN: 404, DEPARTURE_UNKNOWN: 404,
  TOTP_ALREADY_ENROLLED: 409, TOTP_ENROLLMENT_CLOSED: 403, TOTP_NOT_ENROLLED: 403,
};

function dbError(e: unknown): HttpError {
  const err = e as { code?: string; message?: string };
  const code = /^[A-Z_]+/.exec(err.message ?? '')?.[0];
  if (code !== undefined && DB_CODES[code] !== undefined) return new HttpError(DB_CODES[code], code);
  if (err.code === '23505') return new HttpError(409, 'SLUG_TAKEN');
  if (err.code === '23503') return new HttpError(404, 'TOUR_UNKNOWN');
  if (err.code === '23514' || err.code === '22023' || err.code === '22P02') return new HttpError(422, 'INVALID');
  throw e;
}

/** The Admin API's login must be admin_app's and nothing else's: never the service, never an operator. */
export async function assertAdminLogin(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<Record<string, boolean>>(`SELECT
    pg_has_role(current_user, 'admin_app', 'MEMBER') AS admin,
    pg_has_role(current_user, 'commerce_app', 'MEMBER') AS commerce,
    pg_has_role(current_user, 'commerce_operator', 'MEMBER') AS commerce_operator,
    pg_has_role(current_user, 'admin_operator', 'MEMBER') AS admin_operator,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged`);
  const r = rows[0]!;
  if (!r.admin || r.commerce || r.commerce_operator || r.admin_operator || r.privileged) throw new Error('ADMIN_LOGIN_NOT_ISOLATED');
}

/** Credentials of the public service or an operator must never be in this process's environment. */
export const FOREIGN_ENVIRONMENT = ['DATABASE_URL', 'OPERATOR_DATABASE_URL', 'ADMIN_OPERATOR_DATABASE_URL', 'MIGRATION_DATABASE_URL',
  'REFREF_API_KEY', 'NOTISEND_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'S3_SECRET_ACCESS_KEY'];
export function assertAdminEnvironment(env: NodeJS.ProcessEnv): void {
  const found = FOREIGN_ENVIRONMENT.filter(name => env[name] !== undefined && env[name] !== '');
  if (found.length > 0) throw new Error(`ADMIN_ENVIRONMENT_FOREIGN: ${found.join(', ')}`);
}

/** An https origin and nothing more: no path, query, fragment or credentials. */
export function adminOrigin(value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new Error('CONFIG_INVALID: ADMIN_ORIGIN'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if ((u.protocol !== 'https:' && !(local && u.protocol === 'http:')) || u.origin !== value) throw new Error('CONFIG_INVALID: ADMIN_ORIGIN');
  return u.origin;
}

export function createAdminServer(deps: AdminDeps): Server {
  const now = deps.now ?? (() => new Date());
  const host = new URL(deps.origin).host;
  const limiterKey = throttleKey(deps.totpKey);

  async function readiness() {
    try {
      const { rows } = await deps.pool.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
      const schema = rows[0]?.v ?? 0;
      return schema === deps.schemaHead ? { status: 'READY', schema } : { status: 'NOT_READY', reason: 'SCHEMA_NOT_AT_HEAD', schema };
    } catch { return { status: 'NOT_READY', reason: 'DATABASE_UNAVAILABLE' }; }
  }

  /** Same-origin JSON only; checked before a body is read or a session is looked at. */
  function guardWrite(req: IncomingMessage): void {
    if (req.headers.origin !== deps.origin) throw new HttpError(403, 'ORIGIN_REFUSED');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'ORIGIN_REFUSED');
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED');
  }

  async function session(req: IncomingMessage): Promise<Session> {
    const token = cookieToken(req);
    const s = token === undefined ? undefined : await touchSession(deps.pool, token, now());
    if (s === undefined) throw new HttpError(401, 'UNAUTHENTICATED');
    return s;
  }

  async function authorize(req: IncomingMessage, permission: Permission): Promise<Session> {
    const s = await session(req);
    if (!allowed(s.role, permission)) {
      await audit(deps.pool, { adminId: s.adminId, actor: s.login, action: 'PERMISSION.DENIED', outcome: 'REFUSED', details: { permission } });
      throw new HttpError(403, 'FORBIDDEN');
    }
    return s;
  }

  const sessionBody = (s: Session) => ({ login: s.login, role: s.role, sessionId: s.id,
    idleExpiresAt: s.idleExpiresAt.toISOString(), absoluteExpiresAt: s.absoluteExpiresAt.toISOString() });

  function signedIn(res: ServerResponse, issued: IssuedSession): void {
    send(res, 200, sessionBody(issued.session), { 'set-cookie': sessionCookie(issued.token, issued.session.absoluteExpiresAt, now()) });
  }

  /** Throttle, then the password. Every failure looks the same to the caller. */
  async function credentials(req: IncomingMessage, body: Record<string, unknown>): Promise<Account> {
    const login = str(body.login, 64) ?? '';
    try {
      await consumeLoginAttempt(deps.pool, limiterKey, { source: BookingRateLimiter.clientIp(req.headers), login }, now());
    } catch (e) {
      if (e instanceof RateLimited) throw new HttpError(429, 'RATE_LIMITED', { 'retry-after': String(e.retryAfterSeconds) });
      throw e;
    }
    const account = login === '' ? undefined : await findAccount(deps.pool, login);
    const ok = await verifyPassword(body.password, account?.passwordScrypt ?? UNKNOWN_ACCOUNT_HASH);
    if (account === undefined || !ok || account.disabled) {
      await audit(deps.pool, { adminId: account?.id ?? null, actor: account?.login ?? 'anonymous', action: 'AUTH.LOGIN',
        outcome: 'REFUSED', details: { reason: 'CREDENTIALS' } });
      throw new HttpError(401, 'INVALID_CREDENTIALS');
    }
    return account;
  }

  /** The second factor: the matching step is spent in the database, once. */
  async function secondFactor(account: Account, code: unknown, confirming: boolean): Promise<void> {
    const { rows } = await deps.pool.query<{ seed_ciphertext: string; confirmed_at: Date | null }>(
      'SELECT seed_ciphertext, confirmed_at FROM admin_totp WHERE admin_id = $1', [account.id]);
    const row = rows[0];
    if (row === undefined || (row.confirmed_at !== null) === confirming) {
      await audit(deps.pool, { adminId: account.id, actor: account.login, action: 'AUTH.LOGIN', outcome: 'REFUSED',
        details: { reason: confirming ? 'NOT_ENROLLING' : 'ENROLLMENT_REQUIRED' } });
      throw confirming ? new HttpError(409, 'TOTP_ALREADY_ENROLLED') : new HttpError(403, 'TOTP_ENROLLMENT_REQUIRED');
    }
    const step = matchingStep(decryptSeed(deps.totpKey, account.id, row.seed_ciphertext), code, now());
    let accepted = false;
    if (step !== undefined) {
      try {
        accepted = (await deps.pool.query<{ ok: boolean }>('SELECT fn_admin_totp_accept($1, $2, $3) AS ok',
          [account.id, step, confirming])).rows[0]!.ok;
      } catch (e) { throw dbError(e); }
    }
    if (!accepted) {
      await audit(deps.pool, { adminId: account.id, actor: account.login, action: 'AUTH.LOGIN', outcome: 'REFUSED',
        details: { reason: step === undefined ? 'CODE' : 'CODE_REUSED' } });
      throw new HttpError(401, 'INVALID_CREDENTIALS');
    }
  }

  async function login(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req, MAX_AUTH_BODY);
    const account = await credentials(req, body);
    await secondFactor(account, body.code, false);
    const issued = await openSession(deps.pool, account, now());
    await audit(deps.pool, { adminId: account.id, actor: account.login, action: 'AUTH.LOGIN', outcome: 'OK',
      entityType: 'admin_session', entityId: issued.session.id });
    signedIn(res, issued);
  }

  async function enroll(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req, MAX_AUTH_BODY);
    const account = await credentials(req, body);
    const { seed, secret, otpauthUri } = newSeed(account.login);
    try {
      await deps.pool.query('SELECT fn_admin_totp_begin($1, $2)', [account.id, encryptSeed(deps.totpKey, account.id, seed)]);
    } catch (e) {
      const refused = dbError(e);
      await audit(deps.pool, { adminId: account.id, actor: account.login, action: 'TOTP.ENROLL_STARTED', outcome: 'REFUSED',
        details: { reason: refused.code } });
      throw refused;
    }
    await audit(deps.pool, { adminId: account.id, actor: account.login, action: 'TOTP.ENROLL_STARTED', outcome: 'OK' });
    send(res, 200, { secret, otpauthUri });
  }

  async function confirmEnrollment(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req, MAX_AUTH_BODY);
    const account = await credentials(req, body);
    await secondFactor(account, body.code, true);
    const issued = await openSession(deps.pool, account, now());
    await audit(deps.pool, { adminId: account.id, actor: account.login, action: 'TOTP.ENROLLED', outcome: 'OK' });
    await audit(deps.pool, { adminId: account.id, actor: account.login, action: 'AUTH.LOGIN', outcome: 'OK',
      entityType: 'admin_session', entityId: issued.session.id });
    signedIn(res, issued);
  }

  // ---------------------------------------------------------------------------------------------
  // Editorial: thin, role-checked calls of migration 0008's functions. The actor recorded in each
  // revision is `admin:<login>`; the database adds which login wrote it.

  const actor = (s: Session) => `admin:${s.login}`;

  async function listTours(res: ServerResponse) {
    const { rows } = await deps.pool.query(`SELECT t.id, t.slug, t.title, t.published_version AS "publishedVersion",
      t.published_at AS "publishedAt", d.revision AS "draftRevision", d.updated_at AS "draftUpdatedAt"
      FROM tour t LEFT JOIN tour_draft d ON d.tour_id = t.id ORDER BY t.created_at`);
    send(res, 200, { tours: rows });
  }

  async function listDepartures(res: ServerResponse) {
    const { rows } = await deps.pool.query(`SELECT d.id, d.slug, d.tour_id AS "tourId", d.starts_on::text AS "startsOn",
      d.ends_on::text AS "endsOn", d.price_kopecks AS "priceKopecks", d.booking_status AS "bookingStatus", d.is_listed AS "isListed",
      d.published_version AS "publishedVersion", d.published_at AS "publishedAt", r.revision AS "draftRevision"
      FROM departure d LEFT JOIN departure_draft r ON r.departure_id = d.id ORDER BY d.starts_on NULLS LAST, d.created_at`);
    send(res, 200, { departures: rows.map(r => ({ ...r, priceKopecks: r.priceKopecks === null ? null : Number(r.priceKopecks) })) });
  }

  async function readEntity(res: ServerResponse, kind: 'tour' | 'departure', id: string) {
    const { rows } = await deps.pool.query(`SELECT to_jsonb(x) AS row FROM ${kind} x WHERE id = $1`, [id]);
    if (rows[0] === undefined) throw new HttpError(404, `${kind.toUpperCase()}_UNKNOWN`);
    const draft = (await deps.pool.query(`SELECT revision, document, updated_by AS "updatedBy", updated_at AS "updatedAt"
      FROM ${kind}_draft WHERE ${kind}_id = $1`, [id])).rows[0] ?? null;
    const revisions = (await deps.pool.query(`SELECT version, draft_revision AS "draftRevision", document_sha256 AS "documentSha256",
      published_by AS "publishedBy", published_at AS "publishedAt" FROM ${kind}_revision WHERE ${kind}_id = $1 ORDER BY version DESC`, [id])).rows;
    send(res, 200, { [kind]: rows[0].row, draft, revisions });
  }

  async function create(req: IncomingMessage, res: ServerResponse, kind: 'tour' | 'departure') {
    const s = await authorize(req, 'editorial.draft');
    const body = await readJson(req, MAX_AUTH_BODY);
    const slug = str(body.slug, 100);
    const tourId = kind === 'departure' ? str(body.tourId, 36) : undefined;
    if (slug === undefined || (kind === 'departure' && (tourId === undefined || !UUID.test(tourId)))) throw new HttpError(422, 'INVALID');
    let id: string;
    try {
      id = kind === 'tour'
        ? (await deps.pool.query<{ id: string }>('INSERT INTO tour (slug) VALUES ($1) RETURNING id', [slug])).rows[0]!.id
        : (await deps.pool.query<{ id: string }>('INSERT INTO departure (slug, tour_id) VALUES ($1, $2) RETURNING id', [slug, tourId])).rows[0]!.id;
    } catch (e) { throw dbError(e); }
    await audit(deps.pool, { adminId: s.adminId, actor: s.login, action: `${kind.toUpperCase()}.CREATED`, outcome: 'OK', entityType: kind, entityId: id });
    send(res, 201, { id });
  }

  async function saveDraft(req: IncomingMessage, res: ServerResponse, kind: 'tour' | 'departure', id: string) {
    const s = await authorize(req, 'editorial.draft');
    const body = await readJson(req, MAX_EDITORIAL_BODY);
    const expected = int(body.expectedRevision);
    const document = body.document;
    if (expected === undefined || document === null || typeof document !== 'object' || Array.isArray(document)) throw new HttpError(422, 'INVALID');
    let revision: number;
    try {
      revision = (await deps.pool.query<{ r: number }>(`SELECT fn_save_${kind}_draft($1, $2, $3, $4) AS r`,
        [id, expected, document, actor(s)])).rows[0]!.r;
    } catch (e) { throw dbError(e); }
    await audit(deps.pool, { adminId: s.adminId, actor: s.login, action: `${kind.toUpperCase()}.DRAFT_SAVED`, outcome: 'OK',
      entityType: kind, entityId: id, details: { revision } });
    send(res, 200, { revision });
  }

  async function publish(req: IncomingMessage, res: ServerResponse, kind: 'tour' | 'departure', id: string) {
    const s = await authorize(req, 'editorial.publish');
    const body = await readJson(req, MAX_AUTH_BODY);
    const draft = int(body.expectedDraftRevision);
    const published = int(body.expectedPublishedVersion);
    if (draft === undefined || published === undefined) throw new HttpError(422, 'INVALID');
    const client = await deps.pool.connect();
    let version: number;
    try {
      await client.query('BEGIN');
      if (kind === 'departure') await executionChangeGuard(client, id);
      version = (await client.query<{ v: number }>(`SELECT fn_publish_${kind}($1, $2, $3, $4) AS v`, [id, draft, published, actor(s)])).rows[0]!.v;
      await audit(client, { adminId: s.adminId, actor: s.login, action: `${kind.toUpperCase()}.PUBLISHED`, outcome: 'OK',
        entityType: kind, entityId: id, details: { version, draftRevision: draft } });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof HttpError) throw e;
      throw dbError(e);
    } finally { client.release(); }
    send(res, 200, { version });
  }

  /**
   * ADR v2.3 §4: a contract change of a departure that has active or concluded orders is not an
   * ordinary edit. Until its EQUIVALENT/MATERIAL workflow exists (ART-365), such a publish is refused.
   * Under the same departure lock reserve() takes, so no order slips in between.
   */
  async function executionChangeGuard(client: pg.PoolClient, id: string) {
    const { rows } = await client.query<{ slug: string; changed: boolean }>(`SELECT d.slug,
        d.published_at IS NOT NULL AND d.contract IS DISTINCT FROM nullif(r.document->'contract', 'null'::jsonb) AS changed
      FROM departure d LEFT JOIN departure_draft r ON r.departure_id = d.id WHERE d.id = $1`, [id]);
    const d = rows[0];
    if (d === undefined) throw new HttpError(404, 'DEPARTURE_UNKNOWN');
    if (!d.changed) return;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('departure:' || $1, 0))", [d.slug]);
    if ((await client.query<{ a: boolean }>('SELECT fn_admin_departure_has_active_orders($1) AS a', [id])).rows[0]!.a) {
      throw new HttpError(409, 'EXECUTION_CHANGE_CLASSIFICATION_REQUIRED');
    }
  }

  async function auditLog(req: IncomingMessage, res: ServerResponse, url: URL) {
    await authorize(req, 'audit.read');
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1) throw new HttpError(422, 'INVALID');
    const { rows } = await deps.pool.query(`SELECT id, at, login_role AS "loginRole", actor, action, outcome,
      entity_type AS "entityType", entity_id AS "entityId", details FROM admin_audit WHERE id < $1 ORDER BY id DESC LIMIT 100`, [before]);
    send(res, 200, { entries: rows.map(r => ({ ...r, id: Number(r.id) })) });
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (method !== 'GET' && method !== 'HEAD') guardWrite(req);

    if (path === '/api/auth/login' && method === 'POST') return login(req, res);
    if (path === '/api/auth/enroll' && method === 'POST') return enroll(req, res);
    if (path === '/api/auth/enroll/confirm' && method === 'POST') return confirmEnrollment(req, res);
    if (path === '/api/auth/session' && method === 'GET') { send(res, 200, sessionBody(await session(req))); return; }
    if (path === '/api/auth/refresh' && method === 'POST') {
      const s = await session(req);
      const issued = await rotateSession(deps.pool, s, now());
      if (issued === undefined) throw new HttpError(401, 'UNAUTHENTICATED');
      await audit(deps.pool, { adminId: s.adminId, actor: s.login, action: 'AUTH.REFRESHED', outcome: 'OK',
        entityType: 'admin_session', entityId: issued.session.id });
      signedIn(res, issued);
      return;
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = cookieToken(req);
      const s = token === undefined ? undefined : await touchSession(deps.pool, token, now());
      if (s !== undefined) {
        await revokeSession(deps.pool, s.adminId, s.id, 'LOGOUT', now());
        await audit(deps.pool, { adminId: s.adminId, actor: s.login, action: 'AUTH.LOGOUT', outcome: 'OK', entityType: 'admin_session', entityId: s.id });
      }
      send(res, 200, { ok: true }, { 'set-cookie': CLEAR_COOKIE });
      return;
    }
    if (path === '/api/auth/sessions' && method === 'GET') {
      const s = await session(req);
      send(res, 200, { current: s.id, sessions: await liveSessions(deps.pool, s.adminId, now()) });
      return;
    }
    if (path === '/api/auth/sessions/revoke' && method === 'POST') {
      const s = await session(req);
      const id = str((await readJson(req, MAX_AUTH_BODY)).sessionId, 36);
      if (id === undefined || !UUID.test(id)) throw new HttpError(422, 'INVALID');
      if (!await revokeSession(deps.pool, s.adminId, id, 'REVOKED', now())) throw new HttpError(404, 'SESSION_UNKNOWN');
      await audit(deps.pool, { adminId: s.adminId, actor: s.login, action: 'SESSION.REVOKED', outcome: 'OK', entityType: 'admin_session', entityId: id });
      send(res, 200, { ok: true }, id === s.id ? { 'set-cookie': CLEAR_COOKIE } : {});
      return;
    }
    if (path === '/api/audit' && method === 'GET') return auditLog(req, res, url);

    const m = /^\/api\/(tours|departures)(?:\/([0-9a-f-]{36})(?:\/(draft|publish))?)?$/.exec(path);
    if (m) {
      const kind = m[1] === 'tours' ? 'tour' : 'departure';
      const id = m[2];
      if (id !== undefined && !UUID.test(id)) throw new HttpError(404, 'NOT_FOUND');
      if (id === undefined && method === 'GET') { await authorize(req, 'editorial.read'); return kind === 'tour' ? listTours(res) : listDepartures(res); }
      if (id === undefined && method === 'POST') return create(req, res, kind);
      if (id !== undefined && m[3] === undefined && method === 'GET') { await authorize(req, 'editorial.read'); return readEntity(res, kind, id); }
      if (id !== undefined && m[3] === 'draft' && method === 'PUT') return saveDraft(req, res, kind, id);
      if (id !== undefined && m[3] === 'publish' && method === 'POST') return publish(req, res, kind, id);
      throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    }
    throw new HttpError(404, 'NOT_FOUND');
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/healthz') { send(res, 200, { ok: true }); return; }
    if (req.method === 'GET' && path === '/readyz') {
      void readiness().then(r => send(res, r.status === 'READY' ? 200 : 503, { service: ADMIN_SERVICE, ...r, sourceCommit: deps.sourceCommit }));
      return;
    }
    if (req.method === 'GET' && path === '/identity') {
      send(res, 200, { service: ADMIN_SERVICE, sourceCommit: deps.sourceCommit, schemaHead: deps.schemaHead, startedAt: deps.startedAt.toISOString() });
      return;
    }
    // Only the Control Room's own host, through its proxy: never book.* or the public site.
    if (!path.startsWith('/api/')) { send(res, 404, { error: 'NOT_FOUND' }); return; }
    if (req.headers.host !== host) { send(res, 421, { error: 'MISDIRECTED_REQUEST' }); return; }
    route(req, res, url).catch((e: unknown) => {
      if (e instanceof HttpError) { send(res, e.status, { error: e.code }, e.headers); return; }
      deps.log('admin_request_failed', { error: e instanceof Error ? e.name : 'unknown' });
      send(res, 500, { error: 'INTERNAL' });
    });
  });
}
