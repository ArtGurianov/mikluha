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
//   … the same for /api/departures (create takes {slug, tourId}; publish also {classification,
//   notice} for an execution change, ADR v2.3 §4) and /api/content (create takes {kind, slug}:
//   report, review, organizer or legal)
//   GET  /api/departures/<id>/affected-orders   order references and states only (OWNER, EDITOR)
//   GET  /api/changes/<id>/notices              per-order notice states (OWNER, EDITOR)
//   GET/POST /api/media                   list metadata / bounded authenticated upload (OWNER, EDITOR)
//   POST /api/media/<id>/publish|revoke    asynchronous commands (live OWNER only)
//   GET  /api/audit?before=<id>            (OWNER)
//
// Publishing and classifying are the OWNER's, decided from the live session alone: the actor is
// `admin:<login>` of that session, never a name from the request, and the Admin audit row of every
// publish names the session and the AUTH.LOGIN row of the password + TOTP login behind it.
//
// Session: a __Host- cookie (HttpOnly, Secure, SameSite=Strict, Path=/), 30 minutes idle, 12 hours
// at most. Every state-changing request must come from the admin origin itself (Origin, and
// Sec-Fetch-Site when sent) with a JSON body; a request for another host is refused outright.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type pg from 'pg';

import { enqueue } from '../media/service.js';
import { MediaError } from '../media/transform.js';

import { MIGRATIONS_DIR } from '../config.js';
import { readMigrations, type LockedMigration } from '../migration-integrity.js';
import { SchemaAdmission } from '../schema-admission.js';
import { schemaReadiness } from '../schema-readiness.js';

import {
  affectedOrders, changeNotices, createContentItem, createDeparture, createTour, EditorialError, publishContentItem,
  publishDeparture, publishTour, saveContentDraft, saveDepartureDraft, saveTourDraft, type Classification, type ContentKind,
  type Document,
} from '../editorial.js';
import type { Logger } from '../log.js';
import { BookingRateLimiter } from '../rate-limit.js';
import { adminKeys, auditEvidence, type AuditKeyring, type DetailValue } from './attestation.js';
import {
  allowed, audit, consumeLoginAttempt, findAccount, GlobalLoginLimit, liveSessions, lockSession, login as openLogin, RateLimited,
  revokeSession, rotateSession, touchSession, type Account, type IssuedSession, type Permission, type Session,
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
  readonly admission?: SchemaAdmission;
  readonly publisherPool: pg.Pool;
  readonly totpKey: Buffer;
  readonly auditKeys: AuditKeyring;
  /** The Control Room's origin, e.g. https://admin.mikluha-maklai.ru: the only one allowed to write. */
  readonly origin: string;
  readonly schemaHead: number;
  readonly migrations?: readonly LockedMigration[];
  readonly sourceCommit: string | null;
  readonly startedAt: Date;
  readonly log: Logger;
  readonly now?: () => Date;
  /** All login attempts together, refused in memory past its limit (default GLOBAL_LOGIN_LIMIT_PER_MINUTE). */
  readonly loginLimit?: GlobalLoginLimit;
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
    let raw = '', bytes = 0, finished = false;
    const fail = (error: Error) => { if (!finished) { finished = true; raw = ''; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => fail(new HttpError(408,'BODY_TIMEOUT')),20_000);
    if (Number(req.headers['content-length']) > limit) { fail(new HttpError(413,'BODY_TOO_LARGE')); req.resume(); return; }
    req.setEncoding('utf8');
    req.on('data',(chunk:string) => {
      if (finished) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) fail(new HttpError(413,'BODY_TOO_LARGE')); else raw += chunk;
    });
    req.on('end',() => {
      if (finished) return;
      try {
        const value: unknown = JSON.parse(raw);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        finished = true; raw = ''; clearTimeout(timer); resolve(value as Record<string,unknown>);
      } catch { fail(new HttpError(400,'BODY_INVALID')); }
    });
    req.on('error',fail);
    req.on('aborted',() => fail(new HttpError(400,'BODY_ABORTED')));
  });
}

const str = (v: unknown, max = 256) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/** Database refusals the editor can act on, by the code the migration raises. */
const DB_CODES: Record<string, number> = {
  MEDIA_UNKNOWN: 404, MEDIA_STATE_CONFLICT: 409, MEDIA_IDEMPOTENCY_CONFLICT: 409, MEDIA_QUEUE_FULL: 429, MEDIA_INVALID: 422,
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

/** Each API credential reaches only its own capability; neither can assume the other. */
export async function assertAdminLogin(pool: pg.Pool, capability: 'admin_app' | 'admin_publisher' = 'admin_app'): Promise<void> {
  const { rows } = await pool.query<Record<string, boolean>>(`SELECT
    session_user = current_user AS unmasked,
    pg_has_role(current_user, 'admin_app', 'MEMBER') AS admin,
    pg_has_role(current_user, 'admin_publisher', 'MEMBER') AS publisher,
    pg_has_role(current_user, 'commerce_app', 'MEMBER') AS commerce,
    pg_has_role(current_user, 'commerce_operator', 'MEMBER') AS commerce_operator,
    pg_has_role(current_user, 'admin_operator', 'MEMBER') AS admin_operator,
    pg_has_role(current_user, 'media_worker', 'MEMBER') AS media,
    (SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication FROM pg_roles WHERE rolname = current_user) AS privileged`);
  const r = rows[0]!;
  if (!r.unmasked || (capability === 'admin_app' ? !r.admin || r.publisher : !r.publisher || r.admin) || r.commerce || r.commerce_operator || r.admin_operator || r.media || r.privileged) throw new Error('ADMIN_LOGIN_NOT_ISOLATED');
}

/** Credentials of the public service or an operator must never be in this process's environment. */
export const FOREIGN_ENVIRONMENT = ['DATABASE_URL', 'OPERATOR_DATABASE_URL', 'ADMIN_OPERATOR_DATABASE_URL', 'MIGRATION_DATABASE_URL',
  'REFREF_API_KEY', 'NOTISEND_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'S3_SECRET_ACCESS_KEY','MEDIA_DATABASE_URL','MEDIA_S3_ACCESS_KEY_ID','MEDIA_S3_SECRET_ACCESS_KEY'];
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
  const keys = adminKeys(deps.totpKey, deps.auditKeys);
  const loginLimit = deps.loginLimit ?? new GlobalLoginLimit();
  let uploadsInFlight = 0;

  const admission = deps.admission ?? new SchemaAdmission(() => schemaReadiness(deps.pool, {
    schemaHead: deps.schemaHead, migrations: deps.migrations ?? readMigrations(MIGRATIONS_DIR), sourceCommit: deps.sourceCommit,
  }));

  /** Same-origin JSON only; checked before a body is read or a session is looked at. */
  function guardWrite(req: IncomingMessage): void {
    if (req.headers.origin !== deps.origin) throw new HttpError(403, 'ORIGIN_REFUSED');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'ORIGIN_REFUSED');
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED');
  }

  async function session(req: IncomingMessage): Promise<Session> {
    const token = cookieToken(req);
    const s = token === undefined ? undefined : await touchSession(deps.pool, keys, token, now());
    if (s === undefined) throw new HttpError(401, 'UNAUTHENTICATED');
    return s;
  }

  async function authorize(req: IncomingMessage, permission: Permission): Promise<Session> {
    const s = await session(req);
    if (!allowed(s.role, permission)) {
      await audit(deps.pool, keys, { adminId: s.adminId, actor: s.login, action: 'PERMISSION.DENIED', outcome: 'REFUSED', details: { permission } });
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
      loginLimit.consume(now());
      await consumeLoginAttempt(deps.pool, keys.throttle, { source: BookingRateLimiter.clientIp(req.headers), login }, now());
    } catch (e) {
      if (e instanceof RateLimited) throw new HttpError(429, 'RATE_LIMITED', { 'retry-after': String(e.retryAfterSeconds) });
      throw e;
    }
    const account = login === '' ? undefined : await findAccount(deps.pool, login);
    const ok = await verifyPassword(body.password, account?.passwordScrypt ?? UNKNOWN_ACCOUNT_HASH);
    if (account === undefined || !ok || account.disabled) {
      await audit(deps.pool, keys, { adminId: account?.id ?? null, actor: account?.login ?? 'anonymous', action: 'AUTH.LOGIN',
        outcome: 'REFUSED', details: { reason: 'CREDENTIALS' } });
      throw new HttpError(401, 'INVALID_CREDENTIALS');
    }
    return account;
  }

  /**
   * The second factor. The matching step is spent, AUTH.LOGIN written and the session opened in one
   * database call (fn_admin_login): a code is accepted once, and no session exists without one.
   */
  async function secondFactor(account: Account, code: unknown, confirming: boolean): Promise<IssuedSession> {
    const { rows } = await deps.pool.query<{ seed_ciphertext: string; confirmed_at: Date | null }>(
      'SELECT seed_ciphertext, confirmed_at FROM admin_totp WHERE admin_id = $1', [account.id]);
    const row = rows[0];
    if (row === undefined || (row.confirmed_at !== null) === confirming) {
      await audit(deps.pool, keys, { adminId: account.id, actor: account.login, action: 'AUTH.LOGIN', outcome: 'REFUSED',
        details: { reason: confirming ? 'NOT_ENROLLING' : 'ENROLLMENT_REQUIRED' } });
      throw confirming ? new HttpError(409, 'TOTP_ALREADY_ENROLLED') : new HttpError(403, 'TOTP_ENROLLMENT_REQUIRED');
    }
    const step = matchingStep(decryptSeed(deps.totpKey, account.id, row.seed_ciphertext), code, now());
    let issued: IssuedSession | undefined;
    if (step !== undefined) {
      try { issued = await openLogin(deps.pool, keys, account, step, confirming, now()); } catch (e) { throw dbError(e); }
    }
    if (issued === undefined) {
      await audit(deps.pool, keys, { adminId: account.id, actor: account.login, action: 'AUTH.LOGIN', outcome: 'REFUSED',
        details: { reason: step === undefined ? 'CODE' : 'CODE_REUSED' } });
      throw new HttpError(401, 'INVALID_CREDENTIALS');
    }
    return issued;
  }

  async function login(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req, MAX_AUTH_BODY);
    signedIn(res, await secondFactor(await credentials(req, body), body.code, false));
  }

  async function enroll(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req, MAX_AUTH_BODY);
    const account = await credentials(req, body);
    const { seed, secret, otpauthUri } = newSeed(account.login);
    try {
      await deps.pool.query('SELECT fn_admin_totp_begin($1, $2)', [account.id, encryptSeed(deps.totpKey, account.id, seed)]);
    } catch (e) {
      const refused = dbError(e);
      await audit(deps.pool, keys, { adminId: account.id, actor: account.login, action: 'TOTP.ENROLL_STARTED', outcome: 'REFUSED',
        details: { reason: refused.code } });
      throw refused;
    }
    await audit(deps.pool, keys, { adminId: account.id, actor: account.login, action: 'TOTP.ENROLL_STARTED', outcome: 'OK' });
    send(res, 200, { secret, otpauthUri });
  }

  async function confirmEnrollment(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req, MAX_AUTH_BODY);
    signedIn(res, await secondFactor(await credentials(req, body), body.code, true));
  }

  // ---------------------------------------------------------------------------------------------
  // Editorial: role-checked calls of the editorial commands (src/editorial.ts, migrations 0008–0010).
  // The actor is always the session's own `admin:<login>`; the database adds which login wrote it.

  type Kind = 'tour' | 'departure' | 'content';
  const TABLE: Record<Kind, { table: string; key: string }> = {
    tour: { table: 'tour', key: 'tour_id' }, departure: { table: 'departure', key: 'departure_id' },
    content: { table: 'content_item', key: 'item_id' },
  };
  const CONTENT_KINDS: readonly ContentKind[] = ['report', 'review', 'organizer', 'legal'];
  const actor = (s: Session) => `admin:${s.login}`;

  /** Editorial refusals by their kind: a conflict to reload, a bad input, an unknown row, or a rule. */
  function editorialError(e: unknown): HttpError {
    if (!(e instanceof EditorialError)) return dbError(e);
    if (e.code.endsWith('_UNKNOWN')) return new HttpError(404, e.code);
    if (e.code.endsWith('_INVALID')) return new HttpError(422, e.code);
    return new HttpError(409, e.code);
  }

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

  async function listContent(res: ServerResponse) {
    const { rows } = await deps.pool.query(`SELECT c.id, c.kind, c.slug, c.published_version AS "publishedVersion",
      c.published_at AS "publishedAt", d.revision AS "draftRevision"
      FROM content_item c LEFT JOIN content_item_draft d ON d.item_id = c.id ORDER BY c.kind, c.created_at`);
    send(res, 200, { items: rows });
  }

  async function readEntity(res: ServerResponse, kind: Kind, id: string) {
    const { table, key } = TABLE[kind];
    const { rows } = await deps.pool.query(`SELECT to_jsonb(x) AS row FROM ${table} x WHERE id = $1`, [id]);
    if (rows[0] === undefined) throw new HttpError(404, `${kind.toUpperCase()}_UNKNOWN`);
    const draft = (await deps.pool.query(`SELECT revision, document, updated_by AS "updatedBy", updated_at AS "updatedAt"
      FROM ${table}_draft WHERE ${key} = $1`, [id])).rows[0] ?? null;
    const revisions = (await deps.pool.query(`SELECT version, draft_revision AS "draftRevision", document_sha256 AS "documentSha256",
      published_by AS "publishedBy", published_at AS "publishedAt" FROM ${table}_revision WHERE ${key} = $1 ORDER BY version DESC`, [id])).rows;
    send(res, 200, { [kind]: rows[0].row, draft, revisions });
  }

  async function create(req: IncomingMessage, res: ServerResponse, kind: Kind) {
    const s = await authorize(req, 'editorial.draft');
    const body = await readJson(req, MAX_AUTH_BODY);
    const slug = str(body.slug, 100);
    if (slug === undefined) throw new HttpError(422, 'INVALID');
    let id: string;
    try {
      if (kind === 'tour') id = await createTour(deps.pool, slug, actor(s));
      else if (kind === 'departure') {
        const tourId = str(body.tourId, 36);
        if (tourId === undefined || !UUID.test(tourId)) throw new HttpError(422, 'INVALID');
        id = await createDeparture(deps.pool, tourId, slug, actor(s));
      } else {
        const contentKind = CONTENT_KINDS.find(k => k === body.kind);
        if (contentKind === undefined) throw new HttpError(422, 'INVALID');
        id = await createContentItem(deps.pool, contentKind, slug, actor(s));
      }
    } catch (e) { throw e instanceof HttpError ? e : editorialError(e); }
    await audit(deps.pool, keys, { adminId: s.adminId, actor: s.login, action: `${kind.toUpperCase()}.CREATED`, outcome: 'OK',
      entityType: TABLE[kind].table, entityId: id });
    send(res, 201, { id });
  }

  async function saveDraft(req: IncomingMessage, res: ServerResponse, kind: Kind, id: string) {
    const s = await authorize(req, 'editorial.draft');
    const body = await readJson(req, MAX_EDITORIAL_BODY);
    const expected = int(body.expectedRevision);
    const document = body.document;
    if (expected === undefined || document === null || typeof document !== 'object' || Array.isArray(document)) throw new HttpError(422, 'INVALID');
    const save = kind === 'tour' ? saveTourDraft : kind === 'departure' ? saveDepartureDraft : saveContentDraft;
    let revision: number;
    try { revision = await save(deps.pool, id, expected, document as Document, actor(s)); } catch (e) { throw editorialError(e); }
    await audit(deps.pool, keys, { adminId: s.adminId, actor: s.login, action: `${kind.toUpperCase()}.DRAFT_SAVED`, outcome: 'OK',
      entityType: TABLE[kind].table, entityId: id, details: { revision } });
    send(res, 200, { revision });
  }

  /**
   * OWNER only, from the live session alone. An execution change on a sold departure takes its
   * classification and customer notice here (EQUIVALENT applies it with one notice per order;
   * MATERIAL publishes nothing and routes it to move/cancel). The publish and its Admin audit row,
   * which names this session and its AUTH.LOGIN row, commit together.
   */
  async function publish(req: IncomingMessage, res: ServerResponse, kind: Kind, id: string) {
    const s = await authorize(req, 'editorial.publish');
    const body = await readJson(req, MAX_AUTH_BODY);
    const expected = { draftRevision: int(body.expectedDraftRevision), publishedVersion: int(body.expectedPublishedVersion) };
    if (expected.draftRevision === undefined || expected.publishedVersion === undefined) throw new HttpError(422, 'INVALID');
    let change: { classification: Classification; notice: string } | undefined;
    if (body.classification !== undefined && body.classification !== null) {
      if (kind !== 'departure' || (body.classification !== 'EQUIVALENT' && body.classification !== 'MATERIAL')
          || typeof body.notice !== 'string') throw new HttpError(422, 'EXECUTION_CHANGE_CLASSIFICATION_INVALID');
      change = { classification: body.classification, notice: body.notice };
    }
    const at = { draftRevision: expected.draftRevision, publishedVersion: expected.publishedVersion };
    const client = await deps.publisherPool.connect();
    try {
      await client.query('BEGIN');
      // The session again, inside this transaction and held to its end: a revocation or disable
      // that committed after authorize() refuses this publish; one that comes later waits for it.
      const live = await lockSession(client, keys, cookieToken(req)!, s.adminId, now);
      if (live === undefined || live.id !== s.id) throw new HttpError(401, 'UNAUTHENTICATED');
      if (!allowed(live.role, 'editorial.publish')) throw new HttpError(403, 'FORBIDDEN');
      let result: { outcome: string; version: number; changeId: string | null; affectedOrders: number };
      if (kind === 'departure') result = await publishDeparture(client, id, at, actor(s), change);
      else {
        const version = await (kind === 'tour' ? publishTour : publishContentItem)(client, id, at, actor(s));
        result = { outcome: 'PUBLISHED', version, changeId: null, affectedOrders: 0 };
      }
      await audit(client, keys, { adminId: s.adminId, actor: s.login, outcome: 'OK', entityType: TABLE[kind].table, entityId: id,
        action: result.outcome === 'PUBLISHED' ? `${kind.toUpperCase()}.PUBLISHED`
          : result.outcome === 'APPLIED' ? 'DEPARTURE.EXECUTION_CHANGE_EQUIVALENT' : 'DEPARTURE.EXECUTION_CHANGE_MATERIAL',
        details: { sessionId: s.id, authAuditId: s.authAuditId, version: result.version, outcome: result.outcome,
          changeId: result.changeId, affectedOrders: result.affectedOrders, draftRevision: at.draftRevision } });
      await client.query('COMMIT');
      send(res, 200, result);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e instanceof HttpError ? e : editorialError(e);
    } finally { client.release(); }
  }

  /**
   * The audit with its evidence: ATTESTED rows were written by this Admin API (their MAC verifies);
   * FORGED means invalid under a known key; UNVERIFIABLE means its historical key is unavailable.
   * OPERATOR rows come from the operator/owner login and carry none.
   */
  async function auditLog(req: IncomingMessage, res: ServerResponse, url: URL) {
    await authorize(req, 'audit.read');
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1) throw new HttpError(422, 'INVALID');
    const { rows } = await deps.pool.query<{ id: string; at: Date; loginRole: string; adminId: string | null; actor: string;
      action: string; outcome: 'OK' | 'REFUSED'; entityType: string | null; entityId: string | null;
      details: Record<string, DetailValue>; attestation: string | null; eventId: string; keyId: string }>(`SELECT id, at, login_role AS "loginRole",
      admin_id AS "adminId", actor, action, outcome, entity_type AS "entityType", entity_id AS "entityId", details, attestation, event_id AS "eventId", key_id AS "keyId"
      FROM admin_audit WHERE id < $1 ORDER BY id DESC LIMIT 100`, [before]);
    send(res, 200, { entries: rows.map(({ attestation, adminId, ...r }) => ({ ...r, id: Number(r.id),
      evidence: auditEvidence(keys, { ...r, adminId }, attestation) })) });
  }

  async function media(req: IncomingMessage, res: ServerResponse, path: string, method: string) {
    const s = await authorize(
      req,
      method === 'GET' ? 'editorial.read' : path === '/api/media' ? 'editorial.draft' : 'editorial.publish',
    );
    if (method === 'GET' && path === '/api/media') {
      const rows = await deps.pool.query('SELECT * FROM admin_media ORDER BY created_at DESC LIMIT 100');
      send(res, 200, { assets: rows.rows });
      return;
    }
    const match = /^\/api\/media\/([0-9a-f-]{36})\/(publish|revoke)$/.exec(path);
    if (method !== 'POST' || (path !== '/api/media' && (!match || !UUID.test(match[1]!))))
      throw new HttpError(404, 'NOT_FOUND');
    const upload = path === '/api/media';
    if (upload && uploadsInFlight >= 2) throw new HttpError(429, 'MEDIA_QUEUE_FULL');
    if (upload) uploadsInFlight++;
    try {
      const body = await readJson(req, upload ? 12 * 1024 * 1024 : MAX_AUTH_BODY);
      const client = await (upload ? deps.pool : deps.publisherPool).connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='5s'");
        const live = await lockSession(client, keys, cookieToken(req)!, s.adminId, now);
        if (!live || live.id !== s.id) throw new HttpError(401, 'UNAUTHENTICATED');
        if (!allowed(live.role, upload ? 'editorial.draft' : 'editorial.publish'))
          throw new HttpError(403, 'FORBIDDEN');
        const id = upload ? await enqueue(client, body, actor(live)) : match![1]!;
        if (!upload)
          await client.query('SELECT fn_media_request($1,$2,$3)', [id, match![2]!.toUpperCase(), actor(live)]);
        await audit(client, keys, {
          adminId: live.adminId,
          actor: live.login,
          action: upload ? 'MEDIA.UPLOADED' : `MEDIA.${match![2]!.toUpperCase()}_REQUESTED`,
          outcome: 'OK',
          entityType: 'media_asset',
          entityId: id,
          details: { sessionId: live.id, authAuditId: live.authAuditId },
        });
        await client.query('COMMIT');
        send(res, 202, { id, state: upload ? 'UPLOADED' : `${match![2]!.toUpperCase()}_REQUESTED` });
      } catch (e) {
        await client.query('ROLLBACK');
        if (e instanceof MediaError) throw new HttpError(e.status, e.code);
        if (e instanceof HttpError) throw e;
        if ((e as { code?: string }).code === '55P03') throw new HttpError(409, 'MEDIA_BUSY');
        throw dbError(e);
      } finally {
        client.release();
      }
    } finally {
      if (upload) uploadsInFlight--;
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (method !== 'GET' && method !== 'HEAD') guardWrite(req);

    if (path === '/api/media' || path.startsWith('/api/media/')) return media(req,res,path,method);

    if (path === '/api/auth/login' && method === 'POST') return login(req, res);
    if (path === '/api/auth/enroll' && method === 'POST') return enroll(req, res);
    if (path === '/api/auth/enroll/confirm' && method === 'POST') return confirmEnrollment(req, res);
    if (path === '/api/auth/session' && method === 'GET') { send(res, 200, sessionBody(await session(req))); return; }
    if (path === '/api/auth/refresh' && method === 'POST') {
      const s = await session(req);
      const issued = await rotateSession(deps.pool, keys, cookieToken(req)!, s, now());
      if (issued === undefined) throw new HttpError(401, 'UNAUTHENTICATED');
      await audit(deps.pool, keys, { adminId: s.adminId, actor: s.login, action: 'AUTH.REFRESHED', outcome: 'OK',
        entityType: 'admin_session', entityId: issued.session.id });
      signedIn(res, issued);
      return;
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = cookieToken(req);
      const s = token === undefined ? undefined : await touchSession(deps.pool, keys, token, now());
      if (s !== undefined) {
        await revokeSession(deps.pool, s.adminId, s.id, 'LOGOUT', now());
        await audit(deps.pool, keys, { adminId: s.adminId, actor: s.login, action: 'AUTH.LOGOUT', outcome: 'OK', entityType: 'admin_session', entityId: s.id });
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
      await audit(deps.pool, keys, { adminId: s.adminId, actor: s.login, action: 'SESSION.REVOKED', outcome: 'OK', entityType: 'admin_session', entityId: id });
      send(res, 200, { ok: true }, id === s.id ? { 'set-cookie': CLEAR_COOKIE } : {});
      return;
    }
    if (path === '/api/audit' && method === 'GET') return auditLog(req, res, url);

    const orders = /^\/api\/departures\/([0-9a-f-]{36})\/affected-orders$/.exec(path);
    if (orders && method === 'GET' && UUID.test(orders[1]!)) {
      await authorize(req, 'editorial.read');
      try { send(res, 200, { orders: await affectedOrders(deps.pool, orders[1]!) }); } catch (e) { throw editorialError(e); }
      return;
    }
    const notices = /^\/api\/changes\/([0-9a-f-]{36})\/notices$/.exec(path);
    if (notices && method === 'GET' && UUID.test(notices[1]!)) {
      await authorize(req, 'editorial.read');
      send(res, 200, { notices: await changeNotices(deps.pool, notices[1]!) });
      return;
    }
    const m = /^\/api\/(tours|departures|content)(?:\/([0-9a-f-]{36})(?:\/(draft|publish))?)?$/.exec(path);
    if (m) {
      const kind: Kind = m[1] === 'tours' ? 'tour' : m[1] === 'departures' ? 'departure' : 'content';
      const id = m[2];
      if (id !== undefined && !UUID.test(id)) throw new HttpError(404, 'NOT_FOUND');
      if (id === undefined && method === 'GET') {
        await authorize(req, 'editorial.read');
        return kind === 'tour' ? listTours(res) : kind === 'departure' ? listDepartures(res) : listContent(res);
      }
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
      void admission.status().then(r => send(res, r.status === 'READY' ? 200 : 503, { service: ADMIN_SERVICE, ...r, sourceCommit: deps.sourceCommit }));
      return;
    }
    if (req.method === 'GET' && path === '/identity') {
      send(res, 200, { service: ADMIN_SERVICE, sourceCommit: deps.sourceCommit, schemaHead: deps.schemaHead, startedAt: deps.startedAt.toISOString() });
      return;
    }
    // Only the Control Room's own host, through its proxy: never book.* or the public site.
    if (!path.startsWith('/api/')) { send(res, 404, { error: 'NOT_FOUND' }); return; }
    if (req.headers.host !== host) { send(res, 421, { error: 'MISDIRECTED_REQUEST' }); return; }
    admission.run(() => route(req, res, url)).then(r => {
      if (r.status !== 'READY') send(res, 503, { error: 'SCHEMA_NOT_ADMITTED', reason: r.reason });
    }).catch((e: unknown) => {
      if (e instanceof HttpError) { send(res, e.status, { error: e.code }, e.headers); return; }
      deps.log('admin_request_failed', { error: e instanceof Error ? e.name : 'unknown' });
      send(res, 500, { error: 'INTERNAL' });
    });
  });
}
