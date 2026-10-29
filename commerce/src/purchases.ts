// Purchases (TOUR-76 / N2): a stable economic purchase with append-only accepted revisions and a
// lifecycle profile the database assigns once, when the purchase is created (migration 0017).
//
//   * a new purchase is NATIVE_NO_REFERRAL with payment owner MIKLUHA_NATIVE: no attribution, no
//     BOUND, no Refref resolution, checkout attempt or payment, ever (fn_purchase_order_guard);
//   * no request field, promo/query value, worker or migration retry chooses or changes the profile;
//   * an order outside any purchase keeps its own history and owner; its profile provenance is
//     UNRESOLVED, never read as NATIVE_NO_REFERRAL.
//
// Opening a native purchase is not wired to the public booking form: switching new sales to it is
// the separately authorized cutover (docs/refref-v10/05-migration-and-e2e.md §3.2), after native
// payment operations (TOUR-77) exist.

import type pg from 'pg';

import { reserveOrder, type BookingRequest, type NativeBookingResult, type OrderDeps } from './orders.js';

export const NATIVE_PROFILE = 'NATIVE_NO_REFERRAL';
export const NATIVE_PAYMENT_OWNER = 'MIKLUHA_NATIVE';

/**
 * Reserve seats and open a native purchase in one transaction, before any payment opportunity.
 * With `replacementOrderRef` (ownership verified by the caller) it appends a QUOTE_REPLACEMENT
 * revision to the replaced order's purchase under the same purchaseRef.
 */
export function reserveNativePurchase(deps: OrderDeps, req: BookingRequest): Promise<NativeBookingResult> {
  return reserveOrder(deps, req, true);
}

export type PurchaseProfile =
  | { readonly provenance: 'PURCHASE'; readonly purchaseRef: string; readonly revision: number;
      readonly lifecycleProfile: string; readonly paymentOwner: string }
  | { readonly provenance: 'UNRESOLVED' };

/** The order's profile as recorded; null for an unknown order. */
export async function purchaseProfileOf(pool: pg.Pool | pg.PoolClient, orderRef: string): Promise<PurchaseProfile | null> {
  const { rows } = await pool.query<{ provenance: 'PURCHASE' | 'UNRESOLVED'; purchase_ref: string | null; revision: number | null;
    lifecycle_profile: string | null; payment_owner: string | null }>(
    'SELECT provenance, purchase_ref, revision, lifecycle_profile, payment_owner FROM order_purchase_profile WHERE order_ref = $1', [orderRef]);
  const r = rows[0];
  if (r === undefined) return null;
  if (r.provenance === 'UNRESOLVED') return { provenance: 'UNRESOLVED' };
  return { provenance: 'PURCHASE', purchaseRef: r.purchase_ref!, revision: r.revision!,
    lifecycleProfile: r.lifecycle_profile!, paymentOwner: r.payment_owner! };
}

/** Whether the order documents a purchase revision: Refref checkout must never touch it. */
export async function isPurchaseOrder(pool: pg.Pool | pg.PoolClient, orderId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM purchase_revision WHERE document_order_id = $1', [orderId]);
  return rows.length > 0;
}

export interface CurrentPurchase {
  readonly purchaseRef: string; readonly lifecycleProfile: string; readonly paymentOwner: string;
  readonly revision: number; readonly basis: string; readonly revisionHash: string;
  readonly documentOrderRef: string; readonly documentOrderStatus: string; readonly departureSlug: string;
  readonly seats: number; readonly totalKopecks: number; readonly acceptedAt: Date; readonly effectiveAt: Date;
}

/** The current projection of one purchase, at its current revision. */
export async function currentPurchase(pool: pg.Pool | pg.PoolClient, purchaseRef: string): Promise<CurrentPurchase | null> {
  const { rows } = await pool.query<{ purchase_ref: string; lifecycle_profile: string; payment_owner: string; revision: number;
    basis: string; revision_hash: string; document_order_ref: string; document_order_status: string; departure_slug: string;
    seats: number; total_kopecks: string; accepted_at: Date; effective_at: Date }>(
    `SELECT purchase_ref, lifecycle_profile, payment_owner, revision, basis, revision_hash, document_order_ref,
       document_order_status, departure_slug, seats, total_kopecks, accepted_at, effective_at
       FROM purchase_current WHERE purchase_ref = $1`, [purchaseRef]);
  const r = rows[0];
  return r === undefined ? null : {
    purchaseRef: r.purchase_ref, lifecycleProfile: r.lifecycle_profile, paymentOwner: r.payment_owner, revision: r.revision,
    basis: r.basis, revisionHash: r.revision_hash, documentOrderRef: r.document_order_ref,
    documentOrderStatus: r.document_order_status, departureSlug: r.departure_slug, seats: r.seats,
    totalKopecks: Number(r.total_kopecks), acceptedAt: r.accepted_at, effectiveAt: r.effective_at };
}
