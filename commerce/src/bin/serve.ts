// The service: HTTP on PORT, and housekeeping (expiry, erasure) every minute.
//   DATABASE_URL          the runtime login role (member of commerce_app)
//   COMMERCE_ENVIRONMENT  STAGING | PRODUCTION
//   CONTENT_DIR           the site's content/ (in the image: /app/content)
//   source commit         read from the image's immutable /app/identity/identity.json
//   COMMERCE_ORIGIN       fixed in production: https://book.mikluha-maklai.ru
//   SITE_ORIGIN           fixed in production: https://mikluha-maklai.ru
//   REFREF_API_BASE       fixed in production: https://api.refref.ru/v1-rc
//   REFREF_CHECKOUT_ORIGIN  fixed in production: https://checkout.refref.ru
//   REFREF_BUSINESS_ID, REFREF_BUSINESS_SLUG, REFREF_API_KEY   Mikluha's Refref Business and its key
//   UNISENDER_GO_API_KEY, UNISENDER_GO_FROM_EMAIL, UNISENDER_GO_FROM_NAME

import pg from 'pg';

import { PRODUCTION_BUILD_IDENTITY_FILE, readBuildIdentity } from '../build-identity.js';
import { loadCatalog } from '../catalog.js';
import { reconcileAll, type CheckoutDeps } from '../checkout.js';
import { env, environment, MIGRATIONS_DIR, productionAddress } from '../config.js';
import { processEmailOutbox, UniSenderGoClient } from '../email.js';
import { LiveSiteReleaseAdmission } from '../legal-admission.js';
import { jsonLogger } from '../log.js';
import { schemaHead } from '../migrate.js';
import { maintain } from '../orders.js';
import { RefrefClient } from '../refref.js';
import { createCommerceServer, SERVICE } from '../server.js';
import { createWebHandler } from '../web.js';

const log = jsonLogger(SERVICE);
const which = environment();
const catalog = loadCatalog(env('CONTENT_DIR'));
if (which === 'PRODUCTION' && !catalog.launchReady) throw new Error('CONTENT_NOT_LAUNCH_READY: production serves launchReady content only');
const identityPath = which === 'PRODUCTION' ? PRODUCTION_BUILD_IDENTITY_FILE
  : (process.env.BUILD_IDENTITY_FILE || PRODUCTION_BUILD_IDENTITY_FILE);
const identity = await readBuildIdentity(identityPath);
const commerceOrigin = productionAddress(which, 'COMMERCE_ORIGIN', env('COMMERCE_ORIGIN'));
const siteOrigin = productionAddress(which, 'SITE_ORIGIN', env('SITE_ORIGIN'));
const refrefApiBase = productionAddress(which, 'REFREF_API_BASE', env('REFREF_API_BASE'));
const checkoutOrigin = productionAddress(which, 'REFREF_CHECKOUT_ORIGIN', env('REFREF_CHECKOUT_ORIGIN'));
const legalAdmission = which === 'PRODUCTION'
  ? new LiveSiteReleaseAdmission(siteOrigin, { sourceCommit: identity.sourceCommit, catalog }) : undefined;
if (legalAdmission !== undefined) await legalAdmission.verify();
const pool = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 10 });
const checkout: CheckoutDeps = {
  pool, catalog, log,
  ...(legalAdmission ? { legalAdmission } : {}),
  refref: new RefrefClient({ apiBase: refrefApiBase, apiKey: env('REFREF_API_KEY') }),
  merchant: {
    businessId: env('REFREF_BUSINESS_ID'), businessSlug: env('REFREF_BUSINESS_SLUG'),
    checkoutOrigin, origin: commerceOrigin, siteOrigin,
  },
};
const email = new UniSenderGoClient({
  apiKey: env('UNISENDER_GO_API_KEY'), fromEmail: env('UNISENDER_GO_FROM_EMAIL'),
  fromName: env('UNISENDER_GO_FROM_NAME'), commerceOrigin,
  ...(process.env.UNISENDER_GO_REPLY_TO ? { replyTo: process.env.UNISENDER_GO_REPLY_TO } : {}),
});
const server = createCommerceServer({
  pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR),
  sourceCommit: identity.sourceCommit, startedAt: new Date(), ...(legalAdmission ? { legalAdmission } : {}),
  onError: (e) => log('request_failed', { error: e instanceof Error ? e.name : 'unknown' }),
}, createWebHandler(checkout, which === 'STAGING'));
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => log('listening', { port, environment: which, departures: catalog.departures.size }));

let maintenanceRunning = false;
const maintenanceTick = () => {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  // Read-back may fulfil and enqueue; the independent mail worker will see it within ten seconds.
  reconcileAll(checkout)
    .then(() => maintain(pool, log))
    .catch((e: unknown) => log('maintenance_failed', { error: e instanceof Error ? e.name : 'unknown' }))
    .finally(() => { maintenanceRunning = false; });
};
let emailRunning = false;
const emailTick = () => {
  if (emailRunning) return;
  emailRunning = true;
  processEmailOutbox(pool, email, log)
    .catch((e: unknown) => log('email_worker_failed', { error: e instanceof Error ? e.name : 'unknown' }))
    .finally(() => { emailRunning = false; });
};
const maintenanceTimer = setInterval(maintenanceTick, 60_000);
const emailTimer = setInterval(emailTick, 10_000);
maintenanceTick();
emailTick();

const stop = () => {
  clearInterval(maintenanceTimer);
  clearInterval(emailTimer);
  server.close(() => { pool.end().finally(() => process.exit(0)); });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
