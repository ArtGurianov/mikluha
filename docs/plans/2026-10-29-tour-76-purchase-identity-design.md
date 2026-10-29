# TOUR-76 / N2: stable purchase identity and immutable booking revisions

Source implementation of the native-first M3 purchase model
([01 §4](../refref-v10/01-commerce-architecture.md), [02 §2](../refref-v10/02-booking-and-prepayments.md),
[05 §3.1–3.2](../refref-v10/05-migration-and-e2e.md)). Prerequisites TOUR-58, TOUR-61 and TOUR-85
are Done; docs-only PR #49 merged as `31d9aa2`. No SQL installation, cutover, payment, Refref call,
deployment or sales admission is implied.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where the accepted bytes live | The document order (`orders`, `order_document`, `order_passenger`). A revision stores digests and economic terms and points to it | Reuses frozen snapshot, consent, retention and EIS machinery; no parallel merchant system or copied PD |
| Who chooses the profile | Nobody: `fn_open_native_purchase` inserts the constants `NATIVE_NO_REFERRAL` / `MIKLUHA_NATIVE`; `BookingRequest` has no such field and the CHECK admits only these values | Server-assigned and immutable before any payment opportunity |
| Legacy orders | Not backfilled; `order_purchase_profile.provenance = 'UNRESOLVED'`, profile NULL | Missing provenance is not "no prior right"; genuine legacy owner/profile stays in the order's own history |
| Adoption of an existing order | Refused: the document order's database-stamped, immutable creation provenance (`created_xact_id` + `created_xact_at`) must be the current transaction, and the order must be pristine. Pre-0017 orders have none | A worker, migration retry or owner no-op UPDATE cannot make an old or attributed order look new (xmin would) |
| Document order terms | Frozen once a revision documents the order: identity, departure, seats, price, document digests and stored bytes, consent, closure/retention markers once set. Tourist rows: no insert, update or move; delete only by qualified retention (marker, no legal hold, 24 h after the DB-stamped `closed_recorded_at` or 90 days after a settled trip; `maintain()` selects through the same function); TRUNCATE refused | The revision, its accepted bytes, the capacity count and participant continuity can never disagree with the order |
| Completeness | Deferred: at commit revision 1 exists, revisions are contiguous, `current_revision` is the last, every revision has its participant links | Direct owner DML cannot leave a purchase without terms or hide its newest revision |
| `participant_ref` | Identity of a participant within the purchase, carried to the next revision only for exactly one matching identity document + date of birth on each side; new otherwise; trigger refuses forged carries and resurrection | TOUR-79 can tell a kept tourist from a replaced one; the ref outlives PD erasure |
| Retroactive attribution/BOUND | `trg_purchase_order_guard` refuses Refref resolution/attribution and Refref checkout/payment columns on a purchase document order in every state, for every login | Stronger than "after a payment opportunity": the native profile never binds |
| Unpaid repeat checkout (OWNER 29.10.2026) | A cookie-verified replacement of the current document order appends `QUOTE_REPLACEMENT` under the same `purchase_ref`; crossing profiles is refused, backed by a deferred constraint trigger | Continuing the same economic purchase keeps its identity; a technical new order ID is not a new purchase |
| Seat allocation | The revision's departure revision + seats. Capacity is `fn_departure_taken_seats`, counting document orders exactly as before | One source of truth for capacity. Moving seats between departures (a revision whose departure differs from its document order's) is TOUR-79 and must extend this function |
| Payment ownership | `purchase.payment_owner = 'MIKLUHA_NATIVE'`, immutable | Persisted owner routing for TOUR-77/65; legacy attempts keep the Refref owner |
| Money allocation | Not here | Needs TOUR-77 payment operations; TOUR-78 owns allocation facts |
| Revision hash | `sha256` over a JSON object of the document order id, economic terms, participant refs, document digests, UTC times and predecessor hash; derived by the insert trigger. Participant links are (document order, position) by construction | Recomputable from the row, independent of the session time zone; callers cannot supply it; commits to the exact document |
| Trust boundary | Guarantees hold for every login's DML (UPDATE, DELETE, TRUNCATE refused). Trigger-disabling DDL or superuser `session_replication_role` is outside; it reaches production only via attested append-only migrations | An honest statement of what the database enforces versus what migration review controls |

## Not wired to the public form

`reserveNativePurchase` exists for the native checkout entry. The public `POST /orders` keeps
calling `reserve()`, which creates orders outside any purchase (the current Refref RC path). Opening
native purchases from the form before TOUR-77 would create orders nobody can pay. 05 §3.2 requires
the cutover to assign profiles atomically and persistently, which this schema provides; the
switch itself is a separately authorized step.

## Contract for later work

- **TOUR-77** attaches payment operations to `purchase` / `purchase_revision`. A purchase's
  document order never gets a Refref attempt (guard). Native payment state must not reuse the
  guarded Refref columns.
- **TOUR-78** allocates confirmed money to a revision and derives balance and first FULL from the
  effective revision (`effective_at`), not from `recorded_at`.
- **TOUR-79** adds amendment/transfer bases to `purchase_revision.basis` with their consent
  evidence. It must make `fn_departure_taken_seats` count a purchase's current revision rather than
  its document order when they differ, and lock every affected departure in one deterministic order.
- **TOUR-65** capacity changes use `fn_departure_taken_seats` under the departure lock; its grant
  to the Admin role comes with that consumer.
- A future referral profile (TOUR-70/71) needs its own migration widening the profile CHECK and a
  BOUND record created before the first payment opportunity. It cannot convert an existing native
  purchase: the profile is immutable.

## Validation

`commerce/test/purchase-identity.test.ts` runs against PostgreSQL with production roles. Review
backstops (PR #51): frozen document terms keep capacity honest, TRUNCATE is refused and the guard
stays, owner no-op updates cannot make an old order new, incomplete or unadvanced purchases fail at
commit, refs follow identity documents across a revision chain and forged carries fail, the hash
changes with the document order (round 1); stored offer/consent bytes are frozen, and tourist rows
cannot be edited, moved or erased outside qualified retention, which still erases them (round 2); a
backdated first closure opens nothing early and maintain() skips such an order (round 3). Also covered: server
assignment before any payment opportunity, request extras ignored, UNRESOLVED legacy provenance
through maintenance, refused adoption (service, owner, same-transaction touch), refused pre-opening
attribution, NULL/malformed entry input and direct owner inserts, role isolation, owner-level
immutability, guarded referral/payment columns in RESERVED and EXPIRED, zero Refref requests from
`onReturn`/`pay`/read-back/HTTP, replacement continuity and hash chain, cross-profile refusal with
the DB backstop, shared capacity, and concurrency for last seats and parallel replacements.
Existing suites and the ART-327 sabotage run unchanged apart from `resetOrders` and the capacity
query hook. The exact-head image qualification also opens a native purchase on the forward schema. Source tests are not a production migration, restore or provider proof.
