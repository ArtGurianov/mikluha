// The service: HTTP on PORT, and housekeeping (expiry, erasure) every minute.
//   DATABASE_URL          the runtime login role (member of commerce_app)
//   COMMERCE_ENVIRONMENT  STAGING | PRODUCTION
//   CONTENT_DIR           the site's content/ (in the image: /app/content)
//   source commit         read from the image's immutable /app/identity/identity.json
//   COMMERCE_ORIGIN       fixed in production: https://book.mikluha-maklai.ru
//   SITE_ORIGIN           fixed in production: https://mikluha-maklai.ru
//   NOTISEND_API_KEY, NOTISEND_FROM_EMAIL, NOTISEND_FROM_NAME   Notisend transactional email (optional NOTISEND_REPLY_TO)
// The SSR site reads GET /public/v1/catalog (public-api.ts) over the internal network.

import pg from 'pg';

import { PRODUCTION_BUILD_IDENTITY_FILE, readBuildIdentity } from '../build-identity.js';
import { assertProductionContent, loadSiteRelease } from '../catalog.js';
import { env, environment, MIGRATIONS_DIR, productionAddress } from '../config.js';
import { NotisendClient, processEmailOutbox } from '../email.js';
import { processExecutionNotices } from '../execution-notice.js';
import { LiveSiteReleaseAdmission } from '../legal-admission.js';
import { jsonLogger } from '../log.js';
import { readMigrations } from '../migration-integrity.js';
import { maintain } from '../orders.js';
import { SchemaAdmission, schemaWorker } from '../schema-admission.js';
import { schemaReadiness } from '../schema-readiness.js';
import { createPublicApiHandler } from '../public-api.js';
import { createCommerceServer, routes, SERVICE } from '../server.js';
import { createRetiredCheckoutHandler } from '../retired-checkout.js';

const log = jsonLogger(SERVICE);
const which = environment();
const catalog = loadSiteRelease(env('CONTENT_DIR'));
if (which === 'PRODUCTION') assertProductionContent(catalog);
const identityPath = which === 'PRODUCTION' ? PRODUCTION_BUILD_IDENTITY_FILE
  : (process.env.BUILD_IDENTITY_FILE || PRODUCTION_BUILD_IDENTITY_FILE);
const identity = await readBuildIdentity(identityPath);
const commerceOrigin = productionAddress(which, 'COMMERCE_ORIGIN', env('COMMERCE_ORIGIN'));
const siteOrigin = productionAddress(which, 'SITE_ORIGIN', env('SITE_ORIGIN'));
const legalAdmission = which === 'PRODUCTION'
  ? new LiveSiteReleaseAdmission(siteOrigin, { sourceCommit: identity.sourceCommit, catalog }) : undefined;
if (legalAdmission !== undefined) await legalAdmission.verify();
const migrations = readMigrations(MIGRATIONS_DIR);
const pool = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 8 });
const admission = new SchemaAdmission(() => schemaReadiness(pool, {
  schemaHead: migrations.length, migrations, sourceCommit: identity.sourceCommit,
}));
const email = new NotisendClient({
  apiKey: env('NOTISEND_API_KEY'), fromEmail: env('NOTISEND_FROM_EMAIL'),
  fromName: env('NOTISEND_FROM_NAME'), commerceOrigin,
  ...(process.env.NOTISEND_REPLY_TO ? { replyTo: process.env.NOTISEND_REPLY_TO } : {}),
});
const server = createCommerceServer({
  pool, catalog, admission, schemaHead: migrations.length, migrations,
  sourceCommit: identity.sourceCommit, startedAt: new Date(), ...(legalAdmission ? { legalAdmission } : {}),
  onError: (e) => log('request_failed', { error: e instanceof Error ? e.name : 'unknown' }),
}, routes(createPublicApiHandler(pool), createRetiredCheckoutHandler(siteOrigin)));
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => log('listening', { port, environment: which, departures: catalog.departures.size,
  ingress: 'NATIVE_NO_REFERRAL', sales: 'CLOSED' }));

const maintenance = schemaWorker(admission, [
  () => maintain(pool, log),
], (e) => log('maintenance_failed', { error: e instanceof Error ? e.name : 'unknown' }));
const mail = schemaWorker(admission, [
  () => processEmailOutbox(pool, email, log), () => processExecutionNotices(pool, email, log),
], (e) => log('email_worker_failed', { error: e instanceof Error ? e.name : 'unknown' }));
const maintenanceTimer = setInterval(() => { void maintenance.tick(); }, 60_000);
const emailTimer = setInterval(() => { void mail.tick(); }, 10_000);
void maintenance.tick();
void mail.tick();

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenanceTimer);
  clearInterval(emailTimer);
  maintenance.stop(); mail.stop();
  const admitted = admission.drain(); // Synchronously refuses new HTTP/worker admission.
  const http = new Promise<void>((resolve) => { server.close(() => resolve()); });
  void Promise.all([http, admitted, maintenance.drain(), mail.drain()])
    .then(() => Promise.all([pool.end()]))
    .then(() => process.exit(0))
    .catch(() => { log('shutdown_failed', {}); process.exit(1); });

};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
