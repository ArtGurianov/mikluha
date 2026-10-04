import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildSnapshot, canonical, itemName, MAX_ITEM_NAME, resolutionInputHash, snapshotDigest, zonedToUtc,
  type Json, type OrderDeal, type ResolutionLine } from '../src/snapshot.js';

const vectors = JSON.parse(readFileSync(new URL('./refref-rc2-vectors.json', import.meta.url), 'utf8')) as {
  jcsVectors: { name: string; json: string; canonical: string }[];
  mikluhaCase: { snapshot: Record<string, Json>; snapshotHash: string; inputHash: string };
};

test("Refref's refref-jcs-1 vectors", () => {
  for (const v of vectors.jcsVectors) assert.equal(canonical(JSON.parse(v.json) as Json), v.canonical, v.name);
});

test("Refref's Mikluha snapshot case: the same digest and resolution input hash, computed here", () => {
  const s = vectors.mikluhaCase.snapshot;
  assert.equal(snapshotDigest(s), vectors.mikluhaCase.snapshotHash);
  const lines = (s.lines as Record<string, Json>[]).map(({ referralDiscountAmountKopecks: _d, finalAmountKopecks: _f, ...l }) => l);
  assert.equal(resolutionInputHash(s.merchantId as string, s.merchantOrderRef as string, lines as unknown as ResolutionLine[]),
    vectors.mikluhaCase.inputHash);
});

const deal: OrderDeal = { orderRef: 'mk-abcdefghijkl', tourSlug: 'altai', tourTitle: 'Алтай', departureSlug: 'altai-2026-11-01',
  startsOn: '2026-11-01', endsOn: '2026-11-04', seats: 2, amountKopecks: 6_800_000, timezone: 'Asia/Krasnoyarsk' };

test('the snapshot is exactly the qualified Alfa path: one PROVIDER line of quantity 1 equal to the payment', () => {
  const s = buildSnapshot(deal, { merchantId: '3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90',
    referralResolutionId: '7a0e1c3b-5d2f-4e8a-b6c1-9f3d2e4a5b60', termsVersionId: null, discountKopecks: 400_000 },
  { ref: 'booking-terms@2026-10-04', hash: `sha256:${'a'.repeat(64)}` });
  assert.equal(s.totalContractAmountKopecks, 6_400_000);
  assert.deepEqual(s.paymentObligations, [{
    obligationRef: 'full', kind: 'FULL', executionMode: 'ORCHESTRATED', fiscalizationMode: 'PROVIDER', amountKopecks: 6_400_000,
    allocations: [{ lineRef: 'trip', amountKopecks: 6_400_000 }],
    fiscal: { taxSystem: 'USN_INCOME', items: [{ lineRef: 'trip', name: 'Тур «Алтай», 01.11–04.11.2026, 2 чел.', quantity: 1,
      amountKopecks: 6_400_000, vatCode: 'NONE', paymentMethod: 'FULL_PREPAYMENT', paymentObject: 'SERVICE' }] },
  }]);
  assert.deepEqual(s.lines, [{ lineRef: 'trip', offerRef: 'altai', unitRef: 'altai-2026-11-01', quantity: 2,
    merchantOfferAmountKopecks: 6_800_000, serviceStartsAt: '2026-10-31T17:00:00Z', serviceEndsAt: '2026-11-04T16:59:59Z',
    referralDiscountAmountKopecks: 400_000, finalAmountKopecks: 6_400_000 }]);
});

test('nothing outside the qualified path is built', () => {
  const resolved = { merchantId: 'm', referralResolutionId: 'r', termsVersionId: null, discountKopecks: 6_800_000 };
  assert.throws(() => buildSnapshot(deal, resolved, { ref: 'x', hash: 'y' }), /SNAPSHOT_PAYABLE_NOT_POSITIVE/);
  const long = { ...deal, tourTitle: 'А'.repeat(MAX_ITEM_NAME) };
  assert.ok([...itemName(long)].length > MAX_ITEM_NAME);
  assert.throws(() => buildSnapshot(long, { ...resolved, discountKopecks: 0 }, { ref: 'x', hash: 'y' }), /SNAPSHOT_ITEM_NAME_TOO_LONG/);
});

test('local trip dates become UTC instants in the site timezone', () => {
  assert.equal(zonedToUtc('2026-11-01', '00:00:00', 'Asia/Krasnoyarsk'), '2026-10-31T17:00:00Z');
  assert.equal(zonedToUtc('2026-07-01', '12:00:00', 'Europe/Moscow'), '2026-07-01T09:00:00Z');
});
