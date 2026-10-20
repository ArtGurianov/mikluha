# Refref v9 contract status — TOUR

Audit snapshot: Mikluha `419f262ed3dc1e407cebb9560341a6357868c138`,
Refref main `0e46c0ef982bafec2ab11d113ddada01fd214407`, 20 October 2026.
[Draft ADR-140 / PR #92](https://github.com/ArtGurianov/refref/pull/92)
holds owner-approved O1–O10/P1–P7 and proposed v9 architecture. It is not proof
of new schema, merchant API, provider capability or deployment.

## Current implementation and accepted target

`commerce/src/snapshot.ts` emits `refref.shared-checkout-snapshot/2`: line
`unitRef` is the departure slug, `quantity` is the seat count, and start/end
timestamps come from the frozen departure schedule/timezone. This is not one
stable ServiceUnit ID per tourist. Identity must be nonpersonal: names/passports
stay in Mikluha. [ART-394](https://linear.app/art-gurianov/issue/ART-394) freezes
the exact shared manifest and replay/identity contract; ART-383/387 integrate and
qualify it, alongside immutable accepted order contracts in ART-362.

The public tree is still SSG/Sveltia until the separately qualified hard cut.
[ADR v2.3](adr/2026-10-18-ssr-flexible-offers-immutable-contracts.md) is the accepted
SSR/PostgreSQL target; merged Admin/editorial source alone does not install it.
Neither old YAML nor a mutable departure may rewrite an accepted order.

## Reward versus buyer and fiscal obligations

P7 uses each unit's planned tour end plus 14 calendar days, not a merchant
SERVICE_RENDERED switch or a fiscal closing receipt. Approved moves cannot add
more than 30 calendar days to the initial deadline or reopen an expired window.
Customer rights and actual rendering/fiscal evidence remain independent.

One successful full bank payment, including 100% prepayment, qualifies a purchase
for PENDING rewards. FULL_PREPAYMENT and FULL_PAYMENT describe fiscal stages;
a later advance-offset/closing receipt has no new bank payment, unit or reward.
ART-103/269 retain the separate closing-receipt obligation.

Reward shares are allocated once after all discounts, with P6 purchase-level
rounding and deterministic remainder allocation. A timely upheld cancellation
requires proof for exact unit IDs and an independently successful positive
refund (at least one allocated kopeck per affected unit, no reuse). Raw refunds,
compensation and cancellation without refund do not zero the partner reward.
Normal cancellation affects only held PENDING and never creates partner debt.

## Refund qualification and rollout

The existing qualified Alfa PROVIDER execution path is full-only, for its
documented SBP_C2B/CARD scope; `can_execute_partial_refund=false`. ART-285 remains
the real Mikluha → Refref full-refund E2E after ART-276. No test-service or bank
cabinet result substitutes for that merchant-runtime proof.

Merchant-owned partial returns and independent external readback are a different,
unqualified profile: [ART-396](https://linear.app/art-gurianov/issue/ART-396).
ART-263/268 must preserve customer refund execution and add reward-claim handling
without treating the merchant's notification as bank proof. Current launch
stops for unsupported partial/fiscal obligations stay in force.

Local contract work needs no SSH. Persistent reset, evidence preservation,
provider operation, schema installation, custody and sales admission require
their separate gates and exact owner authority. No such operation occurs here.
