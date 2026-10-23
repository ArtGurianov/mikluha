# ART-362: immutable checkout and merchant-held seats

Source implementation of ADR v2.3 §3/§5. No installation, financial activation or production proof.

## Contract, quote and hold

`bookablePublished` is the common PostgreSQL adapter for `/book` and `reserve`. Input syntax,
consents, seats and normalized contact/passenger data are validated before DB checkout or legal
HTTP verification. Departure-dependent age, publication, capacity and contract checks are repeated
under the departure row/advisory lock in one short reservation transaction. Admission uses the
exclusive T−24h cutoff computed from the exact local departure instant.

Each order freezes its complete verified contract snapshot, legal/PD evidence, departure identity
and immutable published revision. An issued quote/document is never replaced or extended. Its
exclusive expiry is the earliest of 15 minutes, hold expiry, frozen departure minus 24 hours and resolution expiry.
This slice applies no merchant promotion; a future one must also contribute its deadline.
Ordinary close permits an issued quote, while cancellation/global stop reject initiation.

The accepted hold is at most 30 minutes, shortened to the T−24h cutoff. Quote expiry alone does not abandon another buyer's hold or
unlock the schedule. The owner-cookie-protected rebooking link carries a replacement reference:
a short departure/order transaction cancels the expired, unstarted old reservation and creates its
replacement, or rolls back both on refusal. It preserves the old document, links the new order via
an immutable unique FK, checks that no operation/payment is unfinished and rejects concurrent
replacement. There is no availability gap or duplicate independent hold.

## Remote operations and stop barriers

A durable order-scoped resolution token is committed before HTTP. The connection and all broad
locks are then released. Applying the result uses a short transaction, rechecks admission and
matches both the token and RESERVED state. Failure rolls back quote/document together. At the end
of an overdue unpaid hold, maintenance atomically revokes this read-only operation token before
expiring the order; a delayed callback cannot apply or begin payment. No payment/frozen/uncertain
attempt is reclaimed this way. The token also protects date changes and explicit replacement
while resolution is active.

Legal HTTP verification and all Refref GETs run without DB transactions or checked-out clients.
Duplicate order requests share one bounded in-process operation; durable state and per-order keys
protect across processes.

A mutating `createAttempt` or `paymentSession` keeps only the global switch share lock, a **shared
initiation barrier** and an order advisory key across its bounded HTTP request. It keeps no departure
row, ordinary exclusive departure advisory lock or order row. Cancellation takes the matching
exclusive barrier; ordinary reservation/publication does not. Removing this final barrier would
reintroduce the already-fixed stop-before-dispatch race. Two dedicated initiation connections
cannot exhaust the normal pool (8 + 2, same credential, total connection budget unchanged).
Cancellation/global stop may wait for an already admitted bounded write; new writes cannot pass a
committed stop. Read-back and fulfilment remain available.

The dispatch marker commits before an external create. A **proven first dispatch goes straight to
POST**, without requiring merchant-order GET permission. STARTED/UNKNOWN work is read back first;
404 never proves that an earlier request cannot still commit. Exact-body/key retries are admitted
under the same stop/deadline barriers. HELD/CANCELLED transitions emit operator logs only after a successful committed transition. RESOLVED
retains sanitized attribution source in its event detail.

## Historical orders

Migration history is unchanged; new schema 0015 adds operation/replacement evidence and the narrower
initiation barrier. RESERVED applications lacking quote provenance still require rebooking; neither
their document nor their discount is rewritten. Already frozen historical PAYMENT_PENDING orders
use the minimum of their original hold, resolution expiry and frozen service start minus 24 hours, validated by
the original snapshot hash. Matching attempts can be recovered/retried, or the identical frozen
attempt body/key dispatched within that original window. No 15-minute quote is backfilled, no new
mutable catalogue facts enter the old contract, and expired/uncertain money remains reconciled.

## Second review disposition

| Item | Resolution and executable evidence |
| --- | --- |
| 1: expired quote occupies capacity | Confirmed UX problem; preserve the explicitly accepted 30-minute hold and add authenticated atomic replacement. Tests fill capacity, race two replacements and prove rollback on capacity refusal. Schedule locking follows the actual hold/active order. |
| 2: network under broad locks | Confirmed. Resolve/legal/GET release all DB clients; writes use only the bounded shared stop barrier in a separate pool. Paused-network tests prove reserve/publish continue, duplicate tabs share GET, and stop/cancellation still serialize. |
| 3: historical pending cannot resume | Confirmed. A real schema-11 upgrade proves existing session retry and identical first/repeated dispatch in the original window, without quote backfill; it also keeps legacy RESERVED repricing refused. |
| 4: first create requires GET | Confirmed. Proven NOT_STARTED dispatch skips GET. A 403 or timeout of the read capability does not prevent the first POST; ambiguity still requires recovery. |
| 5: missing operator logs | Restored for held/cancelled outcomes, including mismatch, unconfirmed work, refused attempts and known-unstarted cancellation. Tests assert reason/ref without tourist data. |
| 6: missing attribution detail | RESOLVED stores sanitized source; GRANT is asserted from real order_event read-back. |
| 7: validation under departure lock | Syntax/consent/contact/passenger normalization moved before checkout and legal HTTP. A test makes any DB checkout fail and proves invalid input uses neither it nor legal HTTP. Age/schedule stay inside authoritative admission. |
| 8: unreachable start-time check | Removed duplicate check; shared bookable admission now compares the exact departure minus 24 hours, following the subsequent owner decision. Tests cover the exclusive zoned cutoff boundary. |
| 9: duplicate adapters/state rules | One published-offer adapter and one explicit departure-refusal helper. OPEN is required for new quotes; ordinary CLOSED intentionally admits issued quotes under ADR v2.3. No DB function return type is rewritten. |
| 10: missing customer messages | Both codes have human text; cancellation maps to DEPARTURE_CANCELLED. HTTP tests exercise cancellation, non-payable notice and owner-authorized rebooking. |

## Validation boundary

Real isolated PostgreSQL 16, runtime/operator/admin roles, FakeRefref fault injection, logical
restore and schema-11 upgrade. Required checks: complete Commerce suite, typecheck/build, root lint,
diff check and exact-head CI. These do not establish provider conformance, owner installation,
PITR/custody, D8 or sales activation. No merge or host operation is authorized here.

## Owner decision and third review — 2026-10-23

Online sales close exactly 24 elapsed hours before the snapshot departure. Reserve, resolve preparation/application, freeze, create and session dispatch enforce it. Hold = min(now+30m, cutoff); quote = min(now+15m, hold, cutoff, resolution expiry). The last-five-minute case displays its actual local hold deadline. After cutoff the customer follows existing organizer contacts at `/#contacts`; uncertain/started money continues recovery with its seat retained. Migration history is preserved; 0016 adds only a resolution start timestamp.

Read-only resolution tokens expire at two minutes in maintain, and also when applying the result. Only RESERVED without payment evidence can lose a token. Old callbacks are fenced by both operation identity and status. Refref docs/28 §5 and `apps/app/src/merchant-api/routes/create-referral-resolution.ts` explicitly confirm identical handoff-token replay (201 → 200, changed fingerprint → 409); retries keep immutable lines and the same token. Maintenance never performs an automatic resolve; invalid/expired handoffs require the existing customer handoff path.

Initiation connection acquisition is capped at 3000 ms; saturation returns PAYMENT_TEMPORARILY_BUSY with the same-order retry path. Every Refref request is capped at 20 seconds of wall time, including streaming response bodies. Network uncertainty remains UNKNOWN with fixed-key recovery. HELD/CANCELLED/resolved logs occur after commit; a lost CAS or a rejected COMMIT creates no false operator transition.

Main was integrated without discarding PR47's delivered ACK identity/status validation. Its BI22–26 regressions and all sabotage mutations remain mandatory. Older BI fixtures now seed the authoritative published catalogue; concurrent independent workers still exercise the database CAS while same-process tabs share one operation.

New regressions cover the exclusive cutoff, shortened hold/quote, delayed resolution, snapshot-bound schedule, post-cutoff settlement, crashed token/retry/stale response, pool saturation, trickling HTTP, lost transition race, failed COMMIT and contact/deadline rendering.

### Local acceptance

312 Commerce tests in 40 suites passed on disposable PostgreSQL 16/FakeRefref, including the actual schema-11 upgrade to 0016 and logical dump/restore. Seventeen tests were added across the review follow-ups, in addition to the 26 business invariants integrated from main. Commerce typecheck/build, root lint and `git diff --check` passed. The separate sensitivity gate requires all 28 mutations to fail by their named business assertions, followed by a passing restored check. Exact-head CI remains a separate PR check.

## Final refusal/dispatch review — 2026-10-23

Only BOOKING_CUTOFF_REACHED receives the completed-online-booking page and organizer contact link. Missing, demo, hidden and unpublished departures retain the generic 404 booking page.

Attempt preparation reads state without arming dispatch. Only after the bounded initiation connection has been acquired does a short transaction on that same connection commit STARTED and its audit event. The row lock is released at COMMIT; a new transaction rechecks admission and holds only the existing shared barriers/advisory key during HTTP. There is no nested pool checkout and no reverse transition of STARTED/UNKNOWN. Pool acquisition failure leaves a fresh attempt NOT_STARTED, so its retry remains POST-first even if merchant GET is forbidden. An already armed/uncertain attempt retains read-back and identical-key recovery.

The saturation regression now asserts both NOT_STARTED and absence of ATTEMPT_DISPATCH_ARMED after the refused wait, then denies merchant GET and proves a successful POST-first retry. Existing stop-after-arming fault injection follows the initiation connection and still proves marker persistence with zero POSTs after a stop. HTTP regressions distinguish all four generic refusals from the cutoff page.

If another worker arms while the first waits for its connection, that first worker releases the connection and enters recovery. A one-connection shared-pool test guards against nested acquisition; a competing-worker test asserts GET recovery with no POST and no reset of uncertainty.

Final local validation: 312/312 Commerce tests, typecheck/build, root lint and diff check passed; all 28 sabotage mutations were killed and restored. Exact-head CI is checked separately in PR #46. No merge, deployment or financial activation.

## Synchronization with main PR48 — 2026-10-23

Main's immutable migration prefix 0001–0012 is preserved byte-for-byte, including its locked compatibility metadata. The never-merged checkout SQL is unchanged but is appended as 0013–0016. Older runtime approvals remain empty: no earlier runtime is declared compatible with checkout's new schema. The schema-11 upgrade fixture now trims both its journal/lock and unused SQL files before upgrade.

The PR branch is rebuilt atop f37c59d because the new history gate checks every parent and correctly rejects a merge that renumbers the old PR-only 0012. The former aa05785 head is retained locally as codex/art-362-before-schema-lock. No deployed history is rewritten, and no SQL is applied outside disposable tests.

Schema admission and draining of admitted HTTP/arrival/workers from PR48 remain intact; shutdown drains both checkout pools. Readiness and forward-schema tests use the actual head while retaining fixed bootstrap-0012 sabotage. Exact-head image qualification is explicitly reviewed for schema 16→17 and publishes its synthetic catalogue to PostgreSQL before reservation. It approves only the isolated additive probe for that exact runtime, not the previous schema-12 runtime on checkout schema 16.
