// The service: HTTP on PORT, and housekeeping (expiry, erasure) every minute.
//   DATABASE_URL          the runtime login role (member of commerce_app)
//   COMMERCE_ENVIRONMENT  STAGING | PRODUCTION
//   CONTENT_DIR           the site's content/ (in the image: /app/content)
//   SOURCE_COMMIT         set by the image build
//   COMMERCE_ORIGIN       this service's public origin, e.g. https://book.mikluha-maklai.ru
//   SITE_ORIGIN           the public site, where the legal pages are, e.g. https://mikluha-maklai.ru
//   REFREF_API_BASE       e.g. https://api.refref.ru/v1-rc
//   REFREF_CHECKOUT_ORIGIN  e.g. https://checkout.refref.ru
//   REFREF_BUSINESS_ID, REFREF_BUSINESS_SLUG, REFREF_API_KEY   Mikluha's Refref Business and its key
//   UNISENDER_GO_API_KEY, UNISENDER_GO_FROM_EMAIL, UNISENDER_GO_FROM_NAME

import pg from 'pg';

import { loadCatalog } from '../catalog.js';
import { reconcileAll, type CheckoutDeps } from '../checkout.js';
import { env, environment, MIGRATIONS_DIR } from '../config.js';
import { processEmailOutbox, UniSenderGoClient } from '../email.js';
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
const pool = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 10 });
const checkout: CheckoutDeps = {
  pool, catalog, log,
  refref: new RefrefClient({ apiBase: env('REFREF_API_BASE'), apiKey: env('REFREF_API_KEY') }),
  merchant: {
    businessId: env('REFREF_BUSINESS_ID'), businessSlug: env('REFREF_BUSINESS_SLUG'),
    checkoutOrigin: env('REFREF_CHECKOUT_ORIGIN'), origin: env('COMMERCE_ORIGIN'), siteOrigin: env('SITE_ORIGIN'),
  },
};
const email = new UniSenderGoClient({
  apiKey: env('UNISENDER_GO_API_KEY'), fromEmail: env('UNISENDER_GO_FROM_EMAIL'),
  fromName: env('UNISENDER_GO_FROM_NAME'), commerceOrigin: checkout.merchant.origin,
  ...(process.env.UNISENDER_GO_REPLY_TO ? { replyTo: process.env.UNISENDER_GO_REPLY_TO } : {}),
});
const server = createCommerceServer({
  pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR),
  sourceCommit: process.env.SOURCE_COMMIT || null, startedAt: new Date(),
  onError: (e) => log('request_failed', { error: e instanceof Error ? e.name : 'unknown' }),
}, createWebHandler(checkout, which === 'STAGING'));
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => log('listening', { port, environment: which, departures: catalog.departures.size }));

let running = false;
const tick = () => {
  if (running) return;
  running = true;
  // Read-back first (it may fulfil and enqueue), then deliver mail, then expiry and erasure.
  reconcileAll(checkout)
    .then(() => processEmailOutbox(pool, email, log))
    .then(() => maintain(pool, log))
    .catch((e: unknown) => log('maintenance_failed', { error: e instanceof Error ? e.name : 'unknown' }))
    .finally(() => { running = false; });
};
const timer = setInterval(tick, 60_000);
tick();

const stop = () => {
  clearInterval(timer);
  server.close(() => { pool.end().finally(() => process.exit(0)); });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
