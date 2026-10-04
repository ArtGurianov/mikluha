// The service: HTTP on PORT, and housekeeping (expiry, erasure) every minute.
//   DATABASE_URL          the runtime login role (member of commerce_app)
//   COMMERCE_ENVIRONMENT  STAGING | PRODUCTION
//   CONTENT_DIR           the site's content/ (in the image: /app/content)
//   SOURCE_COMMIT         set by the image build

import pg from 'pg';

import { loadCatalog } from '../catalog.js';
import { env, environment, MIGRATIONS_DIR } from '../config.js';
import { jsonLogger } from '../log.js';
import { schemaHead } from '../migrate.js';
import { maintain } from '../orders.js';
import { createCommerceServer, SERVICE } from '../server.js';

const log = jsonLogger(SERVICE);
const which = environment();
const catalog = loadCatalog(env('CONTENT_DIR'));
if (which === 'PRODUCTION' && !catalog.launchReady) throw new Error('CONTENT_NOT_LAUNCH_READY: production serves launchReady content only');
const pool = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 10 });
const server = createCommerceServer({
  pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR),
  sourceCommit: process.env.SOURCE_COMMIT || null, startedAt: new Date(),
});
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => log('listening', { port, environment: which, departures: catalog.departures.size }));

let running = false;
const tick = () => {
  if (running) return;
  running = true;
  maintain(pool, log).catch((e: unknown) => log('maintenance_failed', { error: e instanceof Error ? e.name : 'unknown' }))
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
