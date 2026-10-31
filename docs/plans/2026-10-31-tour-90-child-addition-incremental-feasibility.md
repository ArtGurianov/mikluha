# TOUR-90 — incremental feasibility of Admin-adding a participant to a paid purchase

Status: **DECISION INPUT / FEASIBILITY ASSESSMENT**, 2026-10-31. Not a feature GO, not an
implementation, migration, bank movement, cancellation, deployment or public-sale authorization.
This document isolates the *additional* cost of in-place Admin addition **over** the mandatory
TOUR-78/79 foundations and proposes the remaining OWNER choice. It does not re-cost TOUR-78/79.

Provenance: [TOUR-90](https://app.plane.so/art-workspace/browse/TOUR-90/), separated from
[TOUR-75](https://app.plane.so/art-workspace/browse/TOUR-75/) / merged PR #53. Governing policy:
[MK-POLICY-v2.4 §4, §9](../refref-v10/06-mk-policy-v2.4.md) and
[booking-and-prepayments §5, §7](../refref-v10/02-booking-and-prepayments.md). Current schema:
[migration 0017](../../commerce/migrations/0017_purchase_identity_and_revisions.sql).

## 1. The OWNER condition being tested

OWNER conditionally accepts Admin addition of an adult/child to an already-paid purchase **only if
the incremental cost is small and no substantial architecture change is required**. This condition
is not a feature GO (policy §4, §9 / TOUR-90). The initial child booking stays a single
manager-qualified purchase with a travelling parent/guardian (child model A); the adult-after-pay
case stays "open a new public purchase." This assessment answers one question: *does in-place
addition stay inside that "small / no substantial change" envelope, given TOUR-78/79?*

## 2. Baseline already paid for by TOUR-78/79 (not re-counted here)

- **TOUR-78 (N4):** individually-priced ticket/service lines in integer kopecks (replacing
  `total = unit_price × seats`), per-person deposits and allocations, FULL accounting that counts
  each receipt once and is derived from the effective accepted revision, debt notices, 72/24 cutoffs,
  forward-only migration preserving 0017 and earlier bytes.
- **TOUR-79 (N5):** the immutable-revision amendment engine — explicit allowed basis/command types,
  admission/consent preconditions, deterministic capacity locking, atomic revision+seat+money commit,
  replay safety, `NEEDS_RESOLUTION` on paid-but-uncommittable changes, per-revision
  contract/legal/PD-consent digests, and the EIS/fiscal "material revision changed → needs-update"
  wiring. TOUR-79 explicitly builds **same-participant correction, equivalent same-category
  replacement, partial cancellation and full termination** — i.e. revisions that keep or *shrink*
  the participant set.

What TOUR-79 deliberately does **not** build: growing the participant/seat count on a purchase whose
current revision is already paid. That growth is exactly the TOUR-90 delta.

## 3. Current structural starting point (migration 0017)

Relevant invariants that make the delta small:

- `purchase_revision` is **append-only and per-revision immutable**; a change is always a *new*
  revision chained by hash to its predecessor (`fn_purchase_revision_on_insert`). Old revisions,
  documents, seats, price and money provenance are never rewritten (`fn_purchase_order_guard`).
- `participant_refs uuid[]` with `cardinality = seats`; `seats BETWEEN 1 AND 6`. Continuity
  (`fn_purchase_participant_on_insert` / `fn_open_native_purchase`) already **carries an existing
  participant ref unchanged and mints a fresh ref for anyone new** — the machinery to append a new
  participant to a later revision already exists; it is gated only by the allowed `basis` set.
- `fn_departure_taken_seats` already counts the **accepted revision's** seats under the departure
  lock, so a higher seat count in a new revision is counted correctly the moment it is accepted.
- Today `basis IN ('INITIAL','QUOTE_REPLACEMENT')`; QUOTE_REPLACEMENT requires the predecessor order
  CANCELLED and the **same departure**. TOUR-79 extends this allowed set with its amendment bases.

The consequence: because TOUR-78 makes price a **per-line vector** and TOUR-79 makes revisions
**additive and immutable with atomic seat+money+consent commit**, adding a participant is, mechanically,
"append one priced line + one participant_ref + one seat under a new revision basis, open one new
payable, leave every paid line and its money frozen." No re-pricing of paid lines, no cancel/rebook,
no money migration. That is the structural reason the delta *can* be small.

## 4. Incremental delta — concrete command / schema / UI / negative-test

Everything below is work **not** already in TOUR-78/79.

### 4.1 Change, consent, seat and payment lifecycle (must be confirmed against TOUR-79)

The command in §4.2 is **not** a single implicit "reserve + accept + bill" step. The acceptance
review (P1) correctly flags that consent must bind to a *specific proposed* revision and that the
moment the revision becomes accepted and the seat becomes contractually held must be explicit. The
proposed lifecycle, mirroring the transfer offer (booking §9.2, policy §6) rather than inventing a
new money model, is:

1. **PROPOSED.** The operator opens an addition proposal carrying the candidate revision + its
   immutable hash (added line price, participant, seat count). The added seat is placed on a
   **bounded proposal hold only** — not a contractual booking — with its own TTL; the hold is
   released on decline or TTL expiry. No money, no contractual seat yet.
2. **CONSENTED.** The buyer consents through a secure single-use link bound to that exact revision
   hash (a mail-robot scan is not consent). Until this, nothing is contractually added.
3. **ACCEPTED + payable opened.** Default ordering = the **ordinary amendment** ordering of booking
   §7.1: the revision becomes accepted first, then the new payable for the added line opens. The
   added seat becomes a contractual booking only at acceptance. (The transfer-style "pay before
   acceptance via a proposal-scoped operation" is a separate, heavier mode and is **not** proposed
   here.)
4. **NEEDS_RESOLUTION / release.** Decline, TTL expiry, lost target availability, or any
   paid-but-uncommittable state resolves the proposal without ever touching the paid original: the
   proposal hold releases, the original seat/money/contract are untouched, and no contractual
   addition was made.

This directly answers the dangerous case the review raised ("operator added a child, buyer did not
consent, but the seat is already held"): under this lifecycle a non-consented proposal only ever held
a **bounded proposal hold**, which releases — it never became a contractual seat and never opened a
payable.

**Open dependency (gates the "small" verdict):** TOUR-79 provides PROPOSED/consent/atomic-commit and
a proposal hold on a *transfer target* departure. What must be **confirmed or added** is a proposal
hold for an **additional seat on the same departure** and the consent-before-acceptance ordering for
an addition. If TOUR-79 already yields these, the delta is small; if a same-departure additional-seat
hold must be built, that extension is part of the TOUR-90 delta and is accounted in §4.2/§5, not
assumed free. The verdict in §5 is explicitly conditional on this confirmation.

### 4.2 Schema delta (one forward migration on top of TOUR-78/79)

1. **One new revision basis** `PARTICIPANT_ADDITION` added to the `basis` CHECK, with its admission
   preconditions: same purchase, same departure, `new.seats = prev.seats + N` (N ≥ 1, result ≤ 6),
   every predecessor participant_ref carried unchanged, exactly N fresh refs appended. No other
   economic field of the carried lines may differ from the predecessor.
2. **Guardian invariant** for an added minor — three *distinct* conditions, not reducible to "an
   adult is present" (P2): (a) a travelling participant of legal age remains on this
   purchase/departure for the whole revision; (b) that participant is a **confirmed** parent or legal
   guardian, with the qualified authority documents/consents the legal process requires (policy §4,
   fiscal §5); (c) the **permissible relationship** to the specific child is established — age alone
   proves none of this. The data/role/retention design and the exact authority documents are owned by
   TOUR-35/80/84; §4.1 only enforces that the invariant holds across the addition and every later
   supported change. This is a *new* check — TOUR-79's equivalent-category replacement never needed it.
3. **Added-line money isolation:** the new revision opens a payable for the **added line only**; the
   carried lines keep their frozen allocations and any historical FULL (booking §5, §7 — adding a
   participant may re-open a buyer balance but never voids a prior FULL and never creates a second
   Refref commission; native is `NATIVE_NO_REFERRAL` so there is no commission at all). No automatic
   cancellation, no release of the paid original seat, no automatic money movement.

### 4.3 Command delta (Admin, operator-scoped)

- One new operator command `purchase propose-participant <purchaseRef> --seats N --basis child|adult
  --by <operator> --reason <...>` that opens the **PROPOSED** state of §4.1 (candidate revision +
  hash + bounded same-departure proposal hold), and a `purchase commit-participant` path that, after
  proven consent and under TOUR-79's capacity lock, re-checks same-departure availability, validates
  the guardian invariant, appends the revision + participant + line, and opens the new payable in one
  transaction. On decline, TTL expiry, last-seat loss or any paid-but-uncommittable state →
  `NEEDS_RESOLUTION` / hold release (reusing TOUR-79's path), never oversell, original untouched.
- It reuses TOUR-79's consent binding (secure link bound to the immutable candidate hash) and its
  EIS material-revision "needs-update" trigger; it adds no new outbox or provider wire. Any
  same-departure additional-seat hold not already provided by TOUR-79 is part of this delta (§4.1).

### 4.4 UI delta (Control Room / Admin)

- An "Add participant" affordance on a paid purchase that shows the carried (frozen) lines read-only,
  collects the added tourist's qualified identity fields + guardian link + the child tariff line
  price, renders the new payable and the preserved original, and requires explicit operator reason.
  No public-form change (public addition stays out of scope).

### 4.5 Negative-test delta (new scenarios, synthetic data only)

- Addition at the last seat loses to a competing sale → `NEEDS_RESOLUTION`, no oversell, original
  seats and money untouched.
- **Operator proposed, buyer never consented** → only the bounded proposal hold existed; on decline
  or TTL it releases; no contractual seat and no payable were ever created (the §4.1 danger case).
- The new payable going `UNKNOWN` does **not** release the added seat, does **not** touch paid
  lines, and fences a second overlapping instruction on the added scope (booking §4).
- A concurrent amendment that would remove the only guardian is refused against an in-flight child
  addition (and vice-versa); the child-guardian invariant survives every supported change.
- Replay / restart of the add command by the same key is idempotent (one revision, one payable).
- Historic snapshots, 0017 and earlier migration bytes and legacy read/recovery paths unchanged;
  prior FULL preserved; no second commission (N/A under native).

## 5. Feasibility verdict

**CONDITIONAL — small and non-substantial *only if* the §4.1 lifecycle dependency is confirmed, and
bounded strictly to the append-a-line model.** The "small" claim is **not yet proven**; it is proven
once the §4.1 consent/seat/payment lifecycle is confirmed against TOUR-79 (see the measurable test
below).

### 5.1 Measurable "small" criterion (replaces the bare word "small")

Treat the OWNER condition ("small, no substantial change") as **met** only if *all* of the following
hold; **not met** the moment any fails:

- **Migrations:** exactly **one** forward-only migration, adding one `basis` value + its CHECK/guard
  logic and the guardian invariant; it alters **no** existing table's accepted columns and touches
  **no** 0017-or-earlier bytes.
- **Schema:** **no new table** and **no change to the per-line/allocation shapes** delivered by
  TOUR-78 (the added line reuses them); only an appended line + participant + seat.
- **Lifecycle:** the §4.1 PROPOSED → CONSENTED → ACCEPTED+payable → NEEDS_RESOLUTION states are all
  served by TOUR-79 primitives, **plus at most** a same-departure additional-seat proposal hold. If a
  *new money ordering* (e.g. pay-before-acceptance) or a *cross-purchase money move* is required, the
  condition is **not met**.
- **Command/UI:** one operator propose/commit command pair and one Admin panel; **no public-form
  change**.
- **Tests:** on the order of the §4.5 scenarios (≈6), no change to TOUR-78/79's own suites.
- **Money:** zero movement of already-received money; prior FULL preserved; no automatic
  cancel/refund/seat-release of the original.

Any requirement beyond this envelope (seamless conversion, auto-cancel, protected seat migration,
pay-before-accept, a second table, or re-pricing paid lines) flips the verdict to **NOT small /
substantial → out of scope**: that is transfer-class atomic cross-purchase money movement and
collides with the "no automatic cancel / no promise of seamless conversion" prohibition (policy §4,
TOUR-90).

### 5.2 What must be confirmed before the verdict is firm

The single open dependency is §4.1: that TOUR-79 actually provides (or cheaply extends to) the
same-departure additional-seat proposal hold and the consent-before-acceptance ordering. Until that
is confirmed against the delivered TOUR-79 source, the "small" verdict is a **well-founded candidate,
not a proof**, and option A in §7 should not be adopted on this document alone.

The assessment does **not** turn the condition into a GO.

## 6. Interim manager-assisted handling (allowed now, before any GO)

Until a separate GO, a child requested after the adult has paid is handled by the manager without new
code and without breaking any invariant:

- Preserve the existing accepted contract, seat and money exactly as they are; do **not** auto-cancel
  the original booking, release its seat, or promise that the adult's money will move.
- The child is arranged either as an individual manager-qualified decision or as a lawful new
  family booking (single manager purchase with the travelling guardian), each under its own
  acceptance — no promise of a protected migration or of an arbitrary retained penalty (policy §4).
- Record the request and the chosen lawful handling; the original purchase remains a single
  manager-qualified purchase with a travelling parent/guardian for initial child bookings.

## 7. The remaining OWNER choice to obtain

1. **Scope of any future feature:** (A) implement the **additive** Admin addition of §4 — the
   candidate low-cost path, but to be adopted **only after** the §4.1 lifecycle dependency is
   confirmed against delivered TOUR-79 (§5.2) and the §5.1 criterion is met; or (B) keep **interim
   manual handling only** (§6) with no in-place feature. Option A is not recommended for adoption on
   this document alone until that confirmation exists.
2. **Explicit boundary:** confirm that *seamless money conversion / automatic cancellation of the
   original* is **not** required. If it is required, the OWNER condition ("small, no substantial
   change") is **not** met and the feature stays out of scope (handled as a legally-qualified new
   booking + refund, not an in-place conversion).
3. Either choice leaves the shared TOUR-78/79 work counted once; TOUR-90 adds only the §4 delta and
   does not become an unconditional launch criterion (TOUR-78 follow-up note).

No new feature, migration installation, bank movement, cancellation, deployment or public-sale
authorization is created by this document.

---

## Review resolution (2026-10-31, PR #67)

- **P1 — consent/seat/payment lifecycle:** added §4.1 with explicit PROPOSED → CONSENTED →
  ACCEPTED+payable → NEEDS_RESOLUTION states, bounded same-departure proposal hold, and the
  consent-before-acceptance ordering; the "operator proposed, buyer never consented" danger case is
  resolved (hold only, no contractual seat/payable) and covered by a new negative test (§4.5).
- **P2 — measurable "small":** §5.1 replaces the bare word with a pass/fail criterion
  (one migration, no new table, no re-pricing, zero money movement, bounded test count, lifecycle
  served by TOUR-79). The verdict (§5) is now explicitly conditional on confirming §4.1 against
  delivered TOUR-79 (§5.2); option A is not recommended for adoption on this document alone (§7).
- **P2 — guardian invariant:** §4.1(2) now separates legal age, confirmed parent/guardian with
  authority documents, and permissible relationship to the specific child; design owned by
  TOUR-35/80/84.
