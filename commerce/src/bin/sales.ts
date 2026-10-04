// The booking switch (refref ops/runbooks/stop-sales.md). Inside the running container:
//
//   node dist/bin/sales.js status
//   node dist/bin/sales.js close --by <who> --reason "<why>"
//   node dist/bin/sales.js open  --by <who> --reason "<why>"
//
// Closing stops new bookings (and, from slice 2, new payment sessions). It never stops reading
// payments back, fulfilling paid orders or refunds.
import { parseArgs } from 'node:util';

import pg from 'pg';

import { env } from '../config.js';
import { setSalesOpen } from '../orders.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { by: { type: 'string' }, reason: { type: 'string' } } });
const command = positionals[0];
const pool = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 1 });
try {
  if (command === 'open' || command === 'close') {
    if (!values.by || !values.reason) throw new Error('--by and --reason are required');
    await setSalesOpen(pool, command === 'open', values.by, values.reason);
  } else if (command !== 'status') {
    throw new Error('usage: sales.js status | open --by <who> --reason <why> | close --by <who> --reason <why>');
  }
  const { rows } = await pool.query<{ open: boolean; changed_at: Date; changed_by: string; reason: string }>(
    'SELECT open, changed_at, changed_by, reason FROM sales_switch');
  const s = rows[0]!;
  console.log(`SALES=${s.open ? 'OPEN' : 'CLOSED'} since ${s.changed_at.toISOString()} by ${s.changed_by}: ${s.reason}`);
} finally {
  await pool.end();
}
