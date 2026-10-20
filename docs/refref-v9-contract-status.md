# Refref v9 contract status — TOUR

Audit snapshot: Mikluha `419f262ed3dc1e407cebb9560341a6357868c138`,
Refref main `0e46c0ef982bafec2ab11d113ddada01fd214407`, 20 October 2026;
target updated to [Draft ADR-140 revision 7](https://github.com/ArtGurianov/refref/pull/99)
on 21 October 2026 (owner decisions D1–D8). ADR-140 holds owner-approved
O1–O10/P1–P7 as amended by D1–D8 and the proposed v9 architecture. It is not
proof of new schema, merchant API, provider capability or deployment.

## Current implementation and accepted target

`commerce/src/snapshot.ts` emits `refref.shared-checkout-snapshot/2`: one line,
`unitRef` is the departure slug, `quantity` is the seat count, and start/end
timestamps come from the frozen departure schedule/timezone. Under revision 7
this shape is compatible with the v9 money model: one booking is one purchase
with one Commission, and **no per-tourist reward IDs are required**. Identity
stays nonpersonal: names/passports stay in Mikluha.
[ART-394](https://linear.app/art-gurianov/issue/ART-394) freezes the purchase
manifest (input hash and Refref-resolved payable hash) and replay contract;
ART-399 consumes it, ART-383/387 integrate and qualify vNext checkout, alongside
immutable accepted order contracts in ART-362.

When `endsTime` is absent the current producer fills `23:59:59` local time. That
is observed v8 behaviour, not an approved v9 default: ART-399 must carry explicit
end-time provenance (an explicit time or a published, snapshotted end-of-day
rule).

The public tree is still SSG/Sveltia until the separately qualified hard cut.
[ADR v2.3](adr/2026-10-18-ssr-flexible-offers-immutable-contracts.md) is the accepted
SSR/PostgreSQL target; merged Admin/editorial source alone does not install it.
Neither old YAML nor a mutable departure may rewrite an accepted order.

## Reward versus buyer and fiscal obligations

P7 uses the planned tour end plus 14 calendar days (the latest service anchor of
the purchase), not a merchant SERVICE_RENDERED switch or a fiscal closing
receipt. Approved moves cannot add more than 30 calendar days to the initial
deadline or reopen an expired window. Customer rights and actual
rendering/fiscal evidence remain independent.

One successful full bank payment, including 100% prepayment, qualifies a purchase
for one PENDING Commission. FULL_PREPAYMENT and FULL_PAYMENT describe fiscal
stages; a later advance-offset/closing receipt has no new bank payment, line or
reward. ART-103/269 retain the separate closing-receipt obligation. The referral
discount is allocated per line only for receipts and refunds; the current single
fiscal item for the whole booking still needs its price/quantity/amount
reconciliation qualified separately.

The Commission is computed once from the after-discount total (P6 rounding) and
is never split per tourist. Cancelling one tourist of three, with a partial
refund, preserves the whole Commission (D1/D4). It is zeroed only when the whole
booking is cancelled — directly, or by provably non-overlapping cancellations
covering all seats (several documents about the same tourist do not add up) —
with an independently successful positive refund of this booking (any amount,
including a partial one when actual costs are lawfully retained) and a timely
upheld claim. Compensation, no refund and a refund without full cancellation
preserve the reward. Normal cancellation affects only held PENDING and never
creates partner debt.

## Refund qualification and rollout

The existing qualified Alfa PROVIDER execution path is full-only, for its
documented SBP_C2B/CARD scope; `can_execute_partial_refund=false`. That limits
execution, not verification. ART-285 remains the real Mikluha → Refref
full-refund E2E after ART-276. No test-service or bank-cabinet result substitutes
for that merchant-runtime proof.

Merchant-owned partial refunds and independent external readback are a separate,
not yet qualified profile: [ART-396](https://linear.app/art-gurianov/issue/ART-396),
admitted per provider/connection/flow (D7). ART-263/268 must preserve customer
refund execution and add whole-booking claim handling without treating the
merchant's notification as bank proof. Current launch stops for unsupported
partial/fiscal obligations stay in force. D4 only scopes a future limited Mikluha
pilot; it is not an operational GO (D8).

Local contract work needs no SSH. Persistent reset, evidence preservation,
provider operation, schema installation, custody and sales admission require
their separate gates and exact owner authority. No such operation occurs here.
