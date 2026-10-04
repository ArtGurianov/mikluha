// Manual ЕИС operator workflow. This command never talks to ЕИС: the operator files in the ЕИС
// personal account, then records that external fact here using the separate operator credential.
import { parseArgs } from 'node:util';

import pg from 'pg';

import { env } from '../config.js';
import { eisFilingPacket, eisRecords, markEisNeedsUpdate, recordEisSubmitted, type EisRecord } from '../eis.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  by: { type: 'string' }, number: { type: 'string' }, reason: { type: 'string' },
  revision: { type: 'string' },
  'confirmed-in-eis-lk': { type: 'boolean', default: false },
} });
const [command, orderRef] = positionals;
const pool = new pg.Pool({ connectionString: env('OPERATOR_DATABASE_URL'), max: 1 });

const show = (r: EisRecord) => {
  const fields = [`ORDER=${r.orderRef}`, `EIS=${r.status}`];
  fields.push(`REVISION=${r.materialRevision}`);
  if (r.electronicVoucherNumber) fields.push(`NUMBER=${r.electronicVoucherNumber}`);
  if (r.submittedAt) fields.push(`SUBMITTED_AT=${r.submittedAt.toISOString()}`);
  if (r.submittedBy) fields.push(`SUBMITTED_BY=${r.submittedBy}`);
  if (r.lastMarkedNeedsUpdateAt) fields.push(`NEEDS_UPDATE_AT=${r.lastMarkedNeedsUpdateAt.toISOString()}`);
  if (r.needsUpdateReason) fields.push(`REASON=${r.needsUpdateReason}`);
  console.log(fields.join(' '));
};

try {
  if (command === 'status') {
    const rows = await eisRecords(pool, orderRef);
    if (orderRef && rows.length === 0) throw new Error('EIS_ORDER_NOT_PENDING');
    for (const row of rows) show(row);
  } else if (command === 'packet' && orderRef) {
    const packet = await eisFilingPacket(pool, orderRef);
    if (packet === null) throw new Error('EIS_PACKET_UNAVAILABLE');
    console.log(JSON.stringify(packet, null, 2));
  } else if (command === 'submit' && orderRef) {
    const revision = Number(values.revision);
    if (!values.by || !values.number || !Number.isSafeInteger(revision) || revision < 0
      || values['confirmed-in-eis-lk'] !== true) {
      throw new Error('submit requires --by, --number, --revision and --confirmed-in-eis-lk');
    }
    show(await recordEisSubmitted(pool, orderRef, values.number, values.by, revision));
  } else if (command === 'needs-update' && orderRef) {
    if (!values.by || !values.reason) throw new Error('needs-update requires --by and --reason');
    show(await markEisNeedsUpdate(pool, orderRef, values.by, values.reason));
  } else {
    throw new Error('usage: eis.js status [order-ref] | packet <order-ref> | submit <order-ref> --number <actual-number> --revision <packet-revision> --by <who> --confirmed-in-eis-lk | needs-update <order-ref> --by <who> --reason <why>');
  }
} finally {
  await pool.end();
}
