// The booking switch (refref ops/runbooks/stop-sales.md), run by an OPERATOR with the operator
// credential (a login in commerce_operator, never the service's DATABASE_URL: the service cannot
// change the switch). Run in a one-off container from the service's image, never `docker exec` into
// the service, whose uid could read this process's environment (commerce/README.md):
//
//   sales status | close --by <who> --reason "<why>" | open --by <who> --reason "<why>"
//
// Closing stops new bookings (and, from slice 2, new payment sessions). It never stops reading
// payments back, fulfilling paid orders or refunds.
import { parseArgs } from 'node:util';

import pg from 'pg';

import { env } from '../config.js';
import { setSalesOpen } from '../orders.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { by: { type: 'string' }, reason: { type: 'string' } } });
const command = positionals[0];
const pool = new pg.Pool({ connectionString: env('OPERATOR_DATABASE_URL'), max: 1 });
try {
  if (command === 'open' || command === 'close') {
    if (!values.by || !values.reason) throw new Error('--by and --reason are required');
    await setSalesOpen(pool, command === 'open', values.by, values.reason);
  } else if (command !== 'status') {
    throw new Error('usage: sales.js status | open --by <who> --reason <why> | close --by <who> --reason <why>');
  }
  const { rows } = await pool.query<{ open: boolean; changed_at: Date; changed_by: string; login_role: string; reason: string }>(
    'SELECT open, changed_at, changed_by, login_role, reason FROM sales_switch');
  const s = rows[0]!;
  console.log(`SALES=${s.open ? 'OPEN' : 'CLOSED'} since ${s.changed_at.toISOString()} by ${s.changed_by} (${s.login_role}): ${s.reason}`);
} finally {
  await pool.end();
}
