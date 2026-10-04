# ART-47 slice 3d design

Slice 3d adds only the operational evidence for manual filing in ЕИС «Электронная путёвка». It
does not call an ЕИС API, send a travel pack, deploy production, configure Refref Business, or
perform a real payment.

## State and authority

Each paid order has one `order_eis` record. The first database transition into `PAID`, `FULFILLED`
or `REFUNDED` creates `EIS_PENDING` in the same transaction, so a successful contract cannot exist
without a visible filing obligation. The three states are:

- `EIS_PENDING`: payment is proven, but commerce has no evidence that a filing occurred;
- `EIS_SUBMITTED`: an operator filed through the ЕИС personal account and then recorded the actual
  electronic-voucher number;
- `EIS_NEEDS_UPDATE`: a previously submitted filing is stale and needs an operator to update it in
  ЕИС before recording submission again.

Only the separate `commerce_operator` login can call the security-definer transition functions.
The runtime role cannot update the table or call those functions. `submitted_at`, `submitted_by`,
the database login, the actual voucher number, the last stale timestamp and current reason are
stored on the record. A separate append-only event table preserves every transition and prior
number. That history is also the lifetime ownership ledger for voucher numbers: a normalized number
may be reused by its own order after correction, but no other order can claim it, even after the
first order receives a replacement number. A transaction-scoped advisory lock serializes concurrent
claims before the indexed history lookup. A monotonic material revision binds submission to the exact filing packet the operator
reviewed: any intervening contract/tourist change makes the command fail `EIS_PACKET_STALE`. The CLI
requires both that revision and `--confirmed-in-eis-lk`; this is an operator assertion, not
automation.

## Fail-closed changes

Database triggers watch tourist rows, contact data, the frozen Заявка, and the contract facts stored
on `orders`. A factual change after `EIS_SUBMITTED` atomically moves the record to
`EIS_NEEDS_UPDATE`; no code path silently leaves the old filing marked valid. Refund is a material
contract change. The ordinary `PAID -> FULFILLED` acknowledgement is not. Scheduled retention
erasure is marked on the order before deleting personal rows and is deliberately excluded: deleting
stored data after its retention period does not mean the historical ЕИС filing changed.

## Operator workflow and evidence

The operator can list filing state, print one local filing packet, record a submission, or mark an
external mismatch. The packet contains passport-bearing data and must be viewed only in the local
operator terminal—never redirected, logged, pasted into GitHub/Linear, or sent to a foreign
service. The first-sale checklist is in `commerce/runbooks/eis-manual-filing.md`: prove the payment,
compare every stored contract/tourist fact with the ЕИС form, submit manually, record the actual
number, and read back `EIS_SUBMITTED`. ART-293 closes only after that evidence step.
