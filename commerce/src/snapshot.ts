// The deal both Mikluha and Refref hash (refref docs/28 §7): SharedCheckoutSnapshotV1, its
// `refref-jcs-1` digest, and the resolution input hash (§5).
//
// Written from the published contract, not imported from Refref: "both parties compute the digest
// independently" holds only if this side is not Refref's code. test/snapshot.test.ts proves it
// agrees with Refref's own vectors (copied into test/refref-rc2-vectors.json).
//
// The fiscal content is FIXED to the one Alfa path that was qualified end to end (Linear ART-47):
// USN_INCOME, one line, one fiscal item of quantity 1 equal to the whole payment, FULL_PREPAYMENT,
// SERVICE, no VAT, receipt issued by the provider (PROVIDER). Nothing here is configurable.

import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** RFC 8785 JCS for the snapshot's domain: objects, arrays, strings, safe integers, booleans, null. */
export function canonical(value: Json): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`JCS_NOT_SAFE_INTEGER: ${value}`);
    return String(value);
  }
  // RFC 8785 string serialization is ECMAScript's JSON.stringify.
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  // Default sort compares UTF-16 code units: RFC 8785 §3.2.3.
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k]!)}`).join(',')}}`;
}

const digest = (v: Json) => `refref-jcs-1:${createHash('sha256').update(canonical(v), 'utf8').digest('hex')}`;

const byRef = (xs: Json[], key: string): Json[] => [...xs].sort((a, b) => {
  const x = String((a as Record<string, Json>)[key]);
  const y = String((b as Record<string, Json>)[key]);
  return x < y ? -1 : x > y ? 1 : 0;
});

/** `refref-jcs-1` of a snapshot: lines, obligations and allocations sorted by their references. */
export function snapshotDigest(snapshot: Record<string, Json>): string {
  const obligations = (snapshot.paymentObligations as Record<string, Json>[])
    .map((o) => ({ ...o, allocations: byRef(o.allocations as Json[], 'lineRef') }));
  return digest({
    ...snapshot,
    lines: byRef(snapshot.lines as Json[], 'lineRef'),
    paymentObligations: byRef(obligations, 'obligationRef'),
  });
}

/** ResolutionInputV1's digest: what Refref's resolution was bound to (docs/28 §5). */
export function resolutionInputHash(merchantId: string, merchantOrderRef: string, lines: readonly ResolutionLine[]): string {
  return digest({
    schema: 'refref.referral-resolution-input/1', merchantId, merchantOrderRef, currency: 'RUB',
    lines: byRef(lines.map((l) => ({ ...l }) as Record<string, Json>), 'lineRef'),
  });
}

export interface ResolutionLine {
  readonly lineRef: string;
  readonly offerRef: string;
  readonly unitRef: string;
  readonly quantity: number;
  readonly merchantOfferAmountKopecks: number;
  readonly serviceStartsAt: string;
  readonly serviceEndsAt: string;
}

export const LINE_REF = 'trip';
export const OBLIGATION_REF = 'full';
/** RBS limits cartItems names to 100 characters (refref Alfa adapter: RECEIPT_ITEM_NAME_LENGTH). */
export const MAX_ITEM_NAME = 100;

/** UTC instant (second precision, docs/28 §7) of a local wall-clock time in `timezone`. */
export function zonedToUtc(date: string, time: string, timezone: string): string {
  const guess = new Date(`${date}T${time}Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(guess.getTime() - (asLocal - guess.getTime())).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface OrderDeal {
  readonly orderRef: string;
  readonly tourSlug: string;
  readonly tourTitle: string;
  readonly departureSlug: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly startsTime?: string;
  readonly endsTime?: string;
  readonly seats: number;
  readonly amountKopecks: number;
  readonly timezone: string;
}

/** The one line of an order, as Refref resolves it: the whole order, its full price. */
export function orderLine(deal: OrderDeal): ResolutionLine {
  return {
    lineRef: LINE_REF, offerRef: deal.tourSlug, unitRef: deal.departureSlug, quantity: deal.seats,
    merchantOfferAmountKopecks: deal.amountKopecks,
    serviceStartsAt: zonedToUtc(deal.startsOn, deal.startsTime === undefined ? '00:00:00' : `${deal.startsTime}:00`, deal.timezone),
    serviceEndsAt: zonedToUtc(deal.endsOn, deal.endsTime === undefined ? '23:59:59' : `${deal.endsTime}:00`, deal.timezone),
  };
}

const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/** The receipt line's name, e.g. «Тур «Алтай», 10.10–13.10.2026, 2 чел.». */
export function itemName(deal: OrderDeal): string {
  return `Тур «${deal.tourTitle}», ${ddmm(deal.startsOn)}–${ddmm(deal.endsOn)}.${deal.endsOn.slice(0, 4)}, ${deal.seats} чел.`;
}

export interface Resolved {
  readonly merchantId: string;
  readonly referralResolutionId: string;
  readonly termsVersionId: string | null;
  readonly discountKopecks: number;
}

/**
 * The frozen deal. One FULL / ORCHESTRATED / PROVIDER obligation for the whole payable amount, one
 * fiscal item of quantity 1 equal to it. Throws rather than build anything outside the qualified path.
 */
export function buildSnapshot(deal: OrderDeal, resolved: Resolved, legal: { ref: string; hash: string }): Record<string, Json> {
  const line = orderLine(deal);
  const finalAmount = deal.amountKopecks - resolved.discountKopecks;
  if (!Number.isSafeInteger(finalAmount) || finalAmount <= 0) throw new Error('SNAPSHOT_PAYABLE_NOT_POSITIVE');
  const name = itemName(deal);
  if ([...name].length > MAX_ITEM_NAME) throw new Error('SNAPSHOT_ITEM_NAME_TOO_LONG');
  return {
    schema: 'refref.shared-checkout-snapshot/1',
    merchantId: resolved.merchantId,
    merchantOrderRef: deal.orderRef,
    currency: 'RUB',
    referralResolutionId: resolved.referralResolutionId,
    termsVersionId: resolved.termsVersionId,
    lines: [{ ...line, referralDiscountAmountKopecks: resolved.discountKopecks, finalAmountKopecks: finalAmount }],
    totalContractAmountKopecks: finalAmount,
    paymentObligations: [{
      obligationRef: OBLIGATION_REF, kind: 'FULL', executionMode: 'ORCHESTRATED', fiscalizationMode: 'PROVIDER',
      amountKopecks: finalAmount,
      allocations: [{ lineRef: LINE_REF, amountKopecks: finalAmount }],
      fiscal: {
        taxSystem: 'USN_INCOME',
        items: [{ lineRef: LINE_REF, name, quantity: 1, amountKopecks: finalAmount, vatCode: 'NONE',
          paymentMethod: 'FULL_PREPAYMENT', paymentObject: 'SERVICE' }],
      },
    }],
    legalReleaseRef: legal.ref,
    legalReleaseHash: legal.hash,
  };
}
