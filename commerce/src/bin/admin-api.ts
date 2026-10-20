// The isolated Admin API (src/admin/api.ts): the same image as the service, its own container, its
// own login. Behind the Control Room's Nginx only (control-room/nginx.conf.template).
//   ADMIN_DATABASE_URL  the Admin API's login: a member of admin_app and of nothing else
//   ADMIN_ORIGIN        the Control Room's https origin, e.g. https://admin.mikluha-maklai.ru
//   ADMIN_TOTP_KEY      32 random bytes, base64url: encrypts the TOTP seeds (and keys the throttle)
//   source commit       read from the image's immutable /app/identity/identity.json
// It refuses to start with the service's, an operator's or a provider's credential in its environment.

import pg from 'pg';

import { adminOrigin, ADMIN_SERVICE, assertAdminEnvironment, assertAdminLogin, createAdminServer } from '../admin/api.js';
import { parseTotpKey } from '../admin/totp.js';
import { PRODUCTION_BUILD_IDENTITY_FILE, readBuildIdentity } from '../build-identity.js';
import { env, MIGRATIONS_DIR } from '../config.js';
import { jsonLogger } from '../log.js';
import { schemaHead } from '../migrate.js';

const log = jsonLogger(ADMIN_SERVICE);
assertAdminEnvironment(process.env);
const origin = adminOrigin(env('ADMIN_ORIGIN'));
const totpKey = parseTotpKey(env('ADMIN_TOTP_KEY'));
const identity = await readBuildIdentity(PRODUCTION_BUILD_IDENTITY_FILE);
const pool = new pg.Pool({ connectionString: env('ADMIN_DATABASE_URL'), max: 5 });
await assertAdminLogin(pool);
const server = createAdminServer({ pool, totpKey, origin, schemaHead: schemaHead(MIGRATIONS_DIR),
  sourceCommit: identity.sourceCommit, startedAt: new Date(), log });
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => log('listening', { port }));

const stop = () => { server.close(() => { pool.end().finally(() => process.exit(0)); }); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
