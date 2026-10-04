// Emits aggregate, PD-free signals for the host monitor. Exit 2 means an actionable commerce
// condition; exit 0 means clean. Database/transport failures remain ordinary non-zero failures.
import pg from 'pg';

import { env } from '../config.js';
import { commerceMonitorSignals, DEFAULT_PAID_GRACE_SECONDS, monitorHasAlert } from '../monitor.js';

const configuredGrace = process.env.MONITOR_PAID_GRACE_SECONDS;
const paidGraceSeconds = configuredGrace === undefined ? DEFAULT_PAID_GRACE_SECONDS : Number(configuredGrace);
const pool = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 1 });

try {
  const signals = await commerceMonitorSignals(pool, new Date(), paidGraceSeconds);
  console.log(JSON.stringify(signals));
  if (monitorHasAlert(signals)) process.exitCode = 2;
} finally {
  await pool.end();
}
