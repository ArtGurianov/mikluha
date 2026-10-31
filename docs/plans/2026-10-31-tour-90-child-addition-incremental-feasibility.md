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

### 4.1 Schema delta (one forward migration on top of TOUR-78/79)

1. **One new revision basis** `PARTICIPANT_ADDITION` added to the `basis` CHECK, with its admission
   preconditions: same purchase, same departure, `new.seats = prev.seats + N` (N ≥ 1, result ≤ 6),
   every predecessor participant_ref carried unchanged, exactly N fresh refs appended. No other
   economic field of the carried lines may differ from the predecessor.
2. **Guardian-presence invariant** for an added minor: at least one travelling adult
   parent/guardian participant already present on this purchase/departure must remain for the whole
   revision; the addition may not leave a child without a permitted guardian (policy §4). This is a
   *new* check — TOUR-79's equivalent-category replacement never needed it.
3. **Added-line money isolation:** the new revision opens a payable for the **added line only**; the
   carried lines keep their frozen allocations and any historical FULL (booking §5, §7 — adding a
   participant may re-open a buyer balance but never voids a prior FULL and never creates a second
   Refref commission; native is `NATIVE_NO_REFERRAL` so there is no commission at all). No automatic
   cancellation, no release of the paid original seat, no automatic money movement.

### 4.2 Command delta (Admin, operator-scoped)

- One new operator command `purchase add-participant <purchaseRef> --seats N --basis child|adult
  --by <operator> --reason <...>` that, in one transaction after TOUR-79's capacity lock:
  re-checks target availability on the **same** departure, validates the guardian invariant, appends
  the revision + participant + line, and opens the new payable. On last-seat loss or any
  paid-but-uncommittable state → `NEEDS_RESOLUTION` (reusing TOUR-79's path), never oversell.
- It reuses TOUR-79's consent binding (secure link bound to the immutable candidate hash) and its
  EIS material-revision "needs-update" trigger; it adds no new outbox or provider wire.

### 4.3 UI delta (Control Room / Admin)

- An "Add participant" affordance on a paid purchase that shows the carried (frozen) lines read-only,
  collects the added tourist's qualified identity fields + guardian link + the child tariff line
  price, renders the new payable and the preserved original, and requires explicit operator reason.
  No public-form change (public addition stays out of scope).

### 4.4 Negative-test delta (new scenarios, synthetic data only)

- Addition at the last seat loses to a competing sale → `NEEDS_RESOLUTION`, no oversell, original
  seats and money untouched.
- The new payable going `UNKNOWN` does **not** release the added seat, does **not** touch paid
  lines, and fences a second overlapping instruction on the added scope (booking §4).
- A concurrent amendment that would remove the only guardian is refused against an in-flight child
  addition (and vice-versa); the child-guardian invariant survives every supported change.
- Replay / restart of the add command by the same key is idempotent (one revision, one payable).
- Historic snapshots, 0017 and earlier migration bytes and legacy read/recovery paths unchanged;
  prior FULL preserved; no second commission (N/A under native).

## 5. Feasibility verdict

**CONDITIONAL YES — small and non-substantial, *bounded strictly to the append-a-line model above*.**

- *Small, no substantial change* **if** addition = append one priced line + participant + seat under
  one new revision basis, open a new payable, and freeze everything already paid. This rides entirely
  on TOUR-78's per-line pricing and TOUR-79's additive immutable-revision + atomic-commit engine; the
  genuinely new surface is one `basis` value, one guardian invariant, one Admin command, one UI panel
  and ~5 negative tests.
- **NOT small / substantial — out of this envelope** if OWNER requires *seamless conversion*:
  automatically cancelling the original booking, moving the adult's already-received money onto a new
  family purchase, or guaranteeing a protected migration of the old seat. That is transfer-class
  atomic cross-purchase money movement; it re-opens refund/recollection, fiscal re-issue and the
  "no automatic cancel / no promise of seamless conversion" prohibition (policy §4, TOUR-90). It fails
  the OWNER condition and should stay out.

So the condition is satisfiable, but only for the additive model. The assessment does **not** itself
turn the condition into a GO.

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

1. **Scope of any future feature:** (A) implement the **additive** Admin addition of §4 (low-cost,
   non-substantial, recommended if the feature is wanted); or (B) keep **interim manual handling only**
   (§6) with no in-place feature.
2. **Explicit boundary:** confirm that *seamless money conversion / automatic cancellation of the
   original* is **not** required. If it is required, the OWNER condition ("small, no substantial
   change") is **not** met and the feature stays out of scope (handled as a legally-qualified new
   booking + refund, not an in-place conversion).
3. Either choice leaves the shared TOUR-78/79 work counted once; TOUR-90 adds only the §4 delta and
   does not become an unconditional launch criterion (TOUR-78 follow-up note).

No new feature, migration installation, bank movement, cancellation, deployment or public-sale
authorization is created by this document.
