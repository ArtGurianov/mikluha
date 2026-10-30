# TOUR-64 Stage A and TOUR-65 — Control Room

The accepted Plane scope of 2026-10-30 is the source of acceptance. This work is
source only: no deployment, real data entry, payments, sales activation or host
change. TOUR-64 Stage B remains a first-sales prerequisite.

Extend the existing same-origin Control Room and isolated Admin API. A separate
CMS would duplicate authorization and publication; a raw JSON-only editor would
make routine content entry unnecessarily fragile. Use labeled forms for common
fields, structured sections for contracts/content, a text-only safe preview,
explicit save and OWNER publication, immutable history and published read-back.
Never render editor HTML. Preserve unknown content keys when changing a field.

New departures are CLOSED and unlisted. Publishing never changes bookingStatus.
OWNER controls listing, capacity and OPEN/CLOSED independently; the global stop
is read-only in Admin. Do not expose cancellation, order/PII editing or sales
activation. Stage A rejects schedule/contract changes through the Admin publish
path when any historical order exists. Paid-order classification and delivery
qualification remain Stage B, including ACCEPTED versus DELIVERED.

## Canonical database consumer contract

Consume migration 0017's `fn_departure_taken_seats`; introduce no seat ledger.
The lock order is global switch share lock (opening only), status batch advisory
barrier, departure row, existing `departure:<slug>` advisory key. Batches acquire
departure rows in ID order. Checkout already holds the global switch then
departure row/advisory locks. Capacity updates use row then advisory locks and
reload the authoritative seat count. No network I/O occurs inside a transaction.

Each status transition increments a version and clears/replaces its batch
provenance, including a manual CLOSED→CLOSED. Pause all writes one immutable
batch receipt and closes all OPEN rows atomically. Resume batch rechecks each
row and opens only eligible CLOSED rows whose last close still belongs to that
batch; manually touched, cancelled, hidden, new, started or invalid rows stay
closed. Stale expected versions conflict. Publisher credentials alone cannot
change the global stop. API transactions recheck the live OWNER session and
commit the attested audit with the command.

Legal publication requires a saved draft, exact expected versions, explicit
approval and effective date. Store immutable text hash and approval provenance;
publish a separate public legal projection. A processing instruction remains a
DRAFT until its separately qualified signature workflow is completed.

## Validation and independent dependencies

Use a disposable PostgreSQL instance with production capability roles. Cover
authorization/session revocation, stale revisions, draft/public separation,
legal approval/hash, CLOSED defaults, global stop, batch provenance/atomicity,
capacity below taken seats, lock races and role bypass refusals. Build/typecheck
the static Admin and run the existing commerce suite. Exercise the UI at desktop
and narrow widths with synthetic same-origin API fixtures and live API tests.

TOUR-63 owns the authenticated upload/processed-image endpoint and direct-S3
qualification; its Stage 1 receipt is independently required for the full
TOUR-64 Stage A receipt. Never invent successful upload or provider evidence.

CUSTODY_IMPACT: NO — undeployed source and disposable local tests only.

## Source validation receipt — 2026-10-30

- Commerce: full suite **398 PASS**, no skips; after adding the final legal
  identity/whole-batch rollback checks, the affected Admin/controls/public API
  suites **36 PASS**, and final authentication/audit API suite **25 PASS**.
- ART-327 sabotage: baseline 26 invariants pass; **28/28** mutations killed by
  business assertions and restored green, using an explicitly selected disposable
  loopback PostgreSQL 16 server. This is synthetic legacy regression protection,
  not provider/native payment qualification.
- Site: **125 PASS**; staging `build:production` including validation of 146 static
  files, 47 direct media references and 12 SEO pages passes.
- Control Room: typecheck/static export/no-secret check pass; bundle checker test
  passes; explicit lint of the separate Control Room sources passes (root lint
  intentionally excludes this package), and repository lint passes.
- Served static UI with a synthetic same-origin API: edit/save, explicit publish,
  published read-back, immutable slug, escaped script markup in preview, malformed
  JSON blocking save, unsaved-navigation dismissal, approved-media choices,
  CLOSED/global-stop display, disabled resume, pause confirmation/batch receipt.
  Checked 390 and 1440 px viewports with no page overflow; narrow editorial lists
  use labeled stacked rows.

The UI fixture is synthetic; authentication and SQL behavior are exercised by
separate live HTTP tests against real disposable PostgreSQL roles. No real
content, account, legal approval, media, payment or provider request was used.

## Integration status

TOUR-65 has its SSR source/test receipt. TOUR-64 has an editor/legal Stage A
source receipt, with its **full Stage A integration receipt still pending
TOUR-63 Stage 1 and the SSR consumer's adoption of `legalPages`**. Stage B remains
open before first sales; it is not claimed implemented here.

TOUR-63 takes migration suffix 0018; this work is serialized after it as 0019
(merge order #58 → #59 → #61 → #60). No already committed/main/applied migration
may be rewritten. The owner asked for a
PR without cross-chat messages; no messages were sent to those chats.
