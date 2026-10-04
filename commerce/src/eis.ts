// Manual ЕИС filing state (ART-47 slice 3d). The service never submits to ЕИС and never marks an
// order submitted. These functions are called only by the operator CLI with OPERATOR_DATABASE_URL.

import type pg from 'pg';

export type EisStatus = 'EIS_PENDING' | 'EIS_SUBMITTED' | 'EIS_NEEDS_UPDATE';

export interface EisRecord {
  readonly orderRef: string;
  readonly status: EisStatus;
  readonly electronicVoucherNumber: string | null;
  readonly submittedAt: Date | null;
  readonly submittedBy: string | null;
  readonly submittedLoginRole: string | null;
  readonly lastMarkedNeedsUpdateAt: Date | null;
  readonly needsUpdateReason: string | null;
  readonly materialRevision: number;
  readonly submittedRevision: number | null;
}

interface EisRow {
  order_ref: string;
  status: EisStatus;
  electronic_voucher_number: string | null;
  submitted_at: Date | null;
  submitted_by: string | null;
  submitted_login_role: string | null;
  last_marked_needs_update_at: Date | null;
  needs_update_reason: string | null;
  material_revision: string;
  submitted_revision: string | null;
}

const record = (r: EisRow): EisRecord => ({
  orderRef: r.order_ref,
  status: r.status,
  electronicVoucherNumber: r.electronic_voucher_number,
  submittedAt: r.submitted_at,
  submittedBy: r.submitted_by,
  submittedLoginRole: r.submitted_login_role,
  lastMarkedNeedsUpdateAt: r.last_marked_needs_update_at,
  needsUpdateReason: r.needs_update_reason,
  materialRevision: Number(r.material_revision),
  submittedRevision: r.submitted_revision === null ? null : Number(r.submitted_revision),
});

export async function eisRecords(pool: pg.Pool, orderRef?: string): Promise<EisRecord[]> {
  const { rows } = await pool.query<EisRow>(`SELECT o.order_ref, e.status, e.electronic_voucher_number,
      e.submitted_at, e.submitted_by, e.submitted_login_role, e.last_marked_needs_update_at,
      e.needs_update_reason, e.material_revision, e.submitted_revision
    FROM order_eis e JOIN orders o ON o.id = e.order_id
    WHERE ($1::text IS NULL OR o.order_ref = $1)
    ORDER BY e.created_at, o.order_ref`, [orderRef ?? null]);
  return rows.map(record);
}

export async function recordEisSubmitted(pool: pg.Pool, orderRef: string, number: string, by: string,
  expectedRevision: number): Promise<EisRecord> {
  await pool.query('SELECT fn_eis_record_submitted($1, $2, $3, $4)', [orderRef, number, by, expectedRevision]);
  const result = await eisRecords(pool, orderRef);
  return result[0]!;
}

export async function markEisNeedsUpdate(pool: pg.Pool, orderRef: string, by: string, reason: string): Promise<EisRecord> {
  await pool.query('SELECT fn_eis_mark_needs_update($1, $2, $3)', [orderRef, by, reason]);
  const result = await eisRecords(pool, orderRef);
  return result[0]!;
}

export interface EisFilingPacket {
  readonly order: Record<string, unknown>;
  readonly contact: Record<string, unknown>;
  readonly tourists: readonly Record<string, unknown>[];
  readonly contract: Record<string, unknown>;
}

/** Personal filing facts for one order. Print only to the operator's local terminal; never log it. */
export async function eisFilingPacket(pool: pg.Pool, orderRef: string): Promise<EisFilingPacket | null> {
  const order = (await pool.query<Record<string, unknown>>(`SELECT o.order_ref, o.departure_slug,
      to_char(o.trip_starts_on, 'YYYY-MM-DD') AS trip_starts_on,
      to_char(o.trip_ends_on, 'YYYY-MM-DD') AS trip_ends_on, o.seats, o.amount_kopecks,
      o.discount_kopecks, o.payable_kopecks, o.legal_release_ref, o.legal_release_hash,
      e.status AS eis_status, e.electronic_voucher_number, e.material_revision AS eis_material_revision
    FROM orders o JOIN order_eis e ON e.order_id = o.id WHERE o.order_ref = $1`, [orderRef])).rows[0];
  if (order === undefined) return null;
  const contact = (await pool.query<Record<string, unknown>>(`SELECT c.full_name, c.phone, c.email
    FROM order_contact c JOIN orders o ON o.id = c.order_id WHERE o.order_ref = $1`, [orderRef])).rows[0];
  const tourists = (await pool.query<Record<string, unknown>>(`SELECT p.position, p.full_name,
      to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.citizenship, p.document_type,
      p.document_series, p.document_number
    FROM order_passenger p JOIN orders o ON o.id = p.order_id WHERE o.order_ref = $1 ORDER BY p.position`,
  [orderRef])).rows;
  const contract = (await pool.query<Record<string, unknown>>(`SELECT d.kind, d.sha256, d.content
    FROM order_document d JOIN orders o ON o.id = d.order_id
    WHERE o.order_ref = $1 AND d.kind = 'ZAYAVKA'`, [orderRef])).rows[0];
  if (contact === undefined || contract === undefined || tourists.length === 0) return null;
  return { order, contact, tourists, contract };
}
