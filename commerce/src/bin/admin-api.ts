// The isolated Admin API (src/admin/api.ts): the same image as the service, its own container, its
// own login. Behind the Control Room's Nginx only (control-room/nginx.conf.template).
//   ADMIN_DATABASE_URL  the Admin API's login: a member of admin_app and of nothing else
//   ADMIN_PUBLISH_DATABASE_URL  disjoint admin_publisher login, used only after OWNER admission
//   ADMIN_AUDIT_KEY / ADMIN_AUDIT_KEY_ID / ADMIN_AUDIT_PREVIOUS_KEYS  signing and historic verification
//   ADMIN_ORIGIN        the Control Room's https origin, e.g. https://admin.mikluha-maklai.ru
//   ADMIN_TOTP_KEY      32 random bytes, base64url: encrypts the TOTP seeds (and keys the throttle)
//   source commit       read from the image's immutable /app/identity/identity.json
// It refuses to start with the service's, an operator's or a provider's credential in its environment.

import pg from 'pg';

import { adminOrigin, ADMIN_SERVICE, assertAdminEnvironment, assertAdminLogin, createAdminServer } from '../admin/api.js';
import { parseAuditKeys } from '../admin/attestation.js';
import { pruneLoginThrottle } from '../admin/auth.js';
import { parseTotpKey } from '../admin/totp.js';
import { PRODUCTION_BUILD_IDENTITY_FILE, readBuildIdentity } from '../build-identity.js';
import { env, MIGRATIONS_DIR } from '../config.js';
import { jsonLogger } from '../log.js';
import { SchemaAdmission, schemaWorker } from '../schema-admission.js';
import { schemaReadiness } from '../schema-readiness.js';
import { readMigrations } from '../migration-integrity.js';

const log = jsonLogger(ADMIN_SERVICE);
assertAdminEnvironment(process.env);
const origin = adminOrigin(env('ADMIN_ORIGIN'));
const totpKey = parseTotpKey(env('ADMIN_TOTP_KEY'));
const auditKeys = parseAuditKeys(process.env);
const identity = await readBuildIdentity(PRODUCTION_BUILD_IDENTITY_FILE);
const migrations = readMigrations(MIGRATIONS_DIR);
const pool = new pg.Pool({ connectionString: env('ADMIN_DATABASE_URL'), max: 5 });
const publisherPool = new pg.Pool({ connectionString: env('ADMIN_PUBLISH_DATABASE_URL'), max: 3 });
await assertAdminLogin(pool);
await assertAdminLogin(publisherPool, 'admin_publisher');
const admission = new SchemaAdmission(() => schemaReadiness(pool, {
  schemaHead: migrations.length, migrations, sourceCommit: identity.sourceCommit,
}));
const server = createAdminServer({ pool, publisherPool, admission, totpKey, auditKeys, origin, schemaHead: migrations.length, migrations,
  sourceCommit: identity.sourceCommit, startedAt: new Date(), log });
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => log('listening', { port }));

// Spent throttle windows are dropped here, never on the login path.
const prune = schemaWorker(admission, [() => pruneLoginThrottle(pool, new Date())],
  (e) => log('throttle_prune_failed', { error: e instanceof Error ? e.name : 'unknown' }));
const pruneTimer = setInterval(() => { void prune.tick(); }, 5 * 60_000);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(pruneTimer); prune.stop();
  const admitted = admission.drain();
  const http = new Promise<void>((resolve) => { server.close(() => resolve()); });
  void Promise.all([http, admitted, prune.drain()])
    .then(() => Promise.all([pool.end(), publisherPool.end()]))
    .then(() => process.exit(0))
    .catch(() => { log('shutdown_failed', {}); process.exit(1); });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
