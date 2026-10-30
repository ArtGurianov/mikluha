# Mikluha SSR/Admin hard cut — execution review, revision 2, 2026-10-30

Status: review draft, incorporating the OPUS and GPT reviews. This is an
operational simplification proposal, not an approved roadmap replacement or
installation/cutover authority. Plane owns live acceptance and dependencies;
this draft does not change them. Native mode NATIVE_NO_REFERRAL; sales CLOSED.
Private evidence and operational/security details stay in the owning projects.

## What hard cut removes

Use a fresh, separately named PostgreSQL database with the selected immutable
migrations. No customer history import, demo catalogue migration, old S3 media
import, dual writers or compatibility with legacy Mikluha customer orders.
Do not reset/drop the existing database or volume. Recreate required catalogue
and approved media in Control Room; ZERO_IMPORT grants no deletion/reuse rights.

New legal publications still have termsRef, version, hash, effective date and
approval. Historical YAML/legal/payment/fiscal evidence stays preserved.
Recreate the processing_instruction setting deliberately: clean migration 0007
creates a DRAFT template, which is not signed evidence or approval. A blank
customer ledger does not make the old technical/legal configuration disposable.

SSR/Admin cutover does not wait for native payments, Refref v10, full TOUR-82-B
or the deferred VPS-17 photo cache. TOUR-66 prepares source retirement; TOUR-67
owns operational switch/read-back. Native sales have their own later GO.

## Evidence and dated source baseline

TOUR-82-A records NO_REAL_OPERATIONS_VERIFIED=PASS for planning. Four real-money
owner tests were fully refunded by fresh bank read-back; store-wide completeness
and paired fiscal receipts are owner-attested. PASS does not mean zero payment
history, complete native rehearsal or continuing absence of later operations.
Preserve whole-period bank/OFD exports before any future evidence destruction.

Diagnostic disclosure assessment and containment: REFREF-125 (private).

The audit has encrypted remote Git storage, a manifest and successful fresh
retrieval/decryption/member-hash read-back. Independent external-key recovery
and external custody copy are distinct; they remain pending until performed or
a documented alternative is explicitly accepted by the owner under VPS-15.

Planning source: main a65b42bdded1bdd66e59214f3d99eb2b2c279031,
journal 0001–0017; observed old installation 0001–0007. Re-read exact release
and migration set before installation. 0018 is only the next candidate at that
baseline, never a reserved number. Agent A owns migration numbering/journal;
role C supplies media SQL specification and contract tests. CI checks uniqueness,
append-only bytes/checksums and clean application. No agent is dispatched here.

## Cutover gates versus later sales gates

| Required for SSR/Admin cutover | Evidence / owner |
|---|---|
| Relevant current-system inventory and retained test/legal history | TOUR-82-A; no whole TOUR-82-B prerequisite |
| Source-ready SSR/Admin and restricted roles | TOUR-60::SSR_SOURCE_READY, TOUR-64/66; immutable image identity |
| SSR capacity/control slice | Proposed TOUR-65 stage: bookingStatus, OWNER OPEN/CLOSED, atomic pause/resume/batch/capacity, one lock model and no oversell |
| Direct-S3 new media and versioned legal publication | TOUR-63 stage 1, TOUR-58/59; approved sources/rights, private originals, bounded transforms |
| Privacy of the actual SSR/Admin/logging/media flows | SSR_PRIVACY_READY under TOUR-68; truthful policy, hosting/recipients/access/logs and legal approval |
| Exact target database and usable recovery | TOUR-17/57, VPS-15; backup targets new DB, fresh dump read-back, isolated restore and current required PITR/custody proofs |
| CLOSED across all reachable new/legacy payment paths | TOUR-67 negative acceptance; UI, API, old links/caches/routes, missing config fails closed |
| Owner-authorized canary payment deny in advance or same window | REFREF-125::CANARY_PAYMENT_DENIED, separate scope/GO; no new real payment probe |
| Concrete install/switch/recovery manifest and explicit OWNER GO | TOUR-67/VPS-15; named DNS, routes, exact images/schema/config/roles/backup and recovery target |

| Later / independent gate | Boundary |
|---|---|
| Native deposits, HELD/UNKNOWN, top-ups, payment-owner routing | TOUR-77/78/79; not SSR-only source readiness |
| Buyer/tourist/bank/OFD/EIS processing and sales legal acceptance | SALES_PRIVACY_READY before TOUR-38; no postponement of already active SSR/Admin/log flows |
| Provider credentials and bank/fiscal qualification, sales opening | TOUR-83/84/38 and separate GO |
| Final stand-in removal after preserved evidence / accepted cutover | REFREF-125::STANDIN_RETIRED, TOUR-42; payment deny happens earlier |
| Optional assets.refref.ru photo delivery | Separate technical/legal admission; direct cloud.ru is sufficient |
| Legacy S3 removal and old evidence disposal | Separate approved object list, rights/retention/version/backup checks; ZERO_IMPORT is not erasure |

TOUR-65 currently contains broader native acceptance in Plane. The SSR stage
split above is a proposal; a formal acceptance/dependency correction is still
needed before claiming the card unblocked/Done. It must retain uncertain-outcome
fences and never free seats or cancel unknown payments automatically. The
operator global stop remains separate from an ordinary departure close; issued
quotes cannot bypass the global CLOSED cutover gate.

SSR_PRIVACY_READY is scoped to actual public SSR, Control Room/admin sessions,
HTTP/IP logs and media processing. SALES_PRIVACY_READY covers later customer
flows. Closed sales alone does not prove no data is processed. Hosting recipient
questions that affect current flows remain at the SSR stage; only evidenced
inapplicable/future flows can move later. This is a release-scope boundary, not a
new legal determination. Current TOUR-68 acceptance is not weakened here.

## Explicit proposals requiring owner acceptance before use

- **Old DB preservation:** reduce the pre-switch old-database rehearsal to one
  encrypted consistent logical dump, checksum/off-host retrieval/readability,
  required configuration/key references and an untouched original DB/volume.
  This avoids a separate old-schema restore rehearsal when it is not a fallback
  write target. It is a proposal, not a waiver of TOUR-17/57/VPS-15 acceptance.
- **Target recovery:** one demonstrated isolated restore of a fresh target-DB
  backup is the proposed minimum. Defer additional PITR exercises only through an
  explicit revised TOUR-67/VPS-15 recovery acceptance, with a deadline before
  the first real editorial/admin/legal data write or sales, whichever is earlier.
  An almost empty DB does not remove the recovery need for Control Room accounts,
  legal publications or key-bound state. Default remains current PITR acceptance.
- **CUSTODY_PENDING:** a status is not permission to switch. External proof or an
  explicitly accepted recovery alternative must be in the exact owner manifest.
- **Temporary static fallback:** retain the frozen old public static container
  as a route-only fallback during SSR acceptance. This is a proposed recovery
  policy addition; it never restores Sveltia or any writer and needs explicit
  inclusion in switch GO. Confirm that its rendered policy/media/links remain
  acceptable; if not, use an approved static maintenance response instead.

## Installation manifest: required concrete fields

No unresolved placeholders are allowed in the executable manifest presented for
GO. This review chooses a preferred topology, subject to the installation review:

1. **Database placement:** a new named DB inside the existing dedicated Mikluha
   PostgreSQL container/volume, preserving old mikluha_commerce. Record actual
   container identity, DB name, volume, capacity, schema/checksums, owner/runtime/
   admin roles and cross-database CONNECT/grant isolation. Shared volume is not
   an independent backup. If a new container/volume is chosen, record that choice
   and all changed mounts/network/backup resources before authorization.
2. **Runtime units:** public SSR, public Commerce API, Control Room static UI and
   isolated Admin API, each with exact source/image digest, command, domain or
   private upstream and DB role. UI and public book.* must never expose Admin API.
   Determine the selected release's dependencies even with native sales disabled.
3. **DNS/TLS/routing:** owner DNS action for book.mikluha-maklai.ru (site settings
   already reference it); named A/AAAA/CNAME records, TTL, public resolver checks,
   ownership and certificate/proxy read-back. Operator-local lookup on 2026-10-30
   returned NXDOMAIN for A; verify again before requesting or applying records.
   Specify the Admin origin and internal upstreams as well as www/apex. No DNS
   change, certificate issuance or service start is authorized by this document.
4. **Backup retargeting:** canonical backup TARGETS/profile must name the new DB,
   correct container and restricted backup role, with approved off-host prefix,
   recipient/key recovery, timers and WAL/base-backup mapping if used. Verify a
   fresh backup's source DB identity, exact schema and manifest/checksum through
   independent retrieval and isolated restore. An old-DB timer reporting SUCCESS
   is not acceptance. Retain old backups; map old/new streams without overwriting
   history or breaking shared backup/provider credentials. Avoid any backup gap.
5. **Legal/config:** deliberate processing_instruction decision/evidence; active
   legal refs/hashes/approval; catalogue/media state; safe CLOSED defaults;
   disabled provider initiation; intended host/Coolify secret authorities.
6. **Fallback:** frozen old static image/source and actual running digest,
   approved content and route target; no writers/auto-deploy. Define route
   switch/reverse-switch commands and read-backs, decision window and retirement.
7. **Admission/recovery:** negative matrix, canary deny receipt, target backup/
   restore/PITR/custody receipts, stop conditions and any explicitly accepted
   exceptions. No new bank/refund probe as a verification shortcut.
8. **Credentials:** consumer-by-consumer list for each proposed PAT/Sveltia S3
   revocation, evidence of no backup/new-media/shared consumer, owner approval,
   method of proving old write denial and recovery of the new stack without it.
   Do not use an unapproved upload/push to prove denial in production.

## Owner-authorized maintenance window

1. Reconfirm inventory, exact manifests and global CLOSED. Unexpected operations
   or unknown outcome stop the switch and preserve evidence. Installation and
   traffic switching are separate named owner authorizations, even in one window.
2. Execute separately approved REFREF-125 CANARY_PAYMENT_DENIED before traffic
   switch or at the beginning of the same window. Preserve history first; retain
   read-only reconciliation; do not revoke shared production acquiring authority.
3. Disable old publish workflow/schedule, auto-deploy and Sveltia writing paths.
   Keep the frozen static container for the approved fallback window only. Prevent
   two writers; retired writer credentials are not needed for serving static HTML.
4. Confirm target backup is already producing and restoring the new DB, then
   switch public routes to the selected SSR/Admin stack. Read back image identity,
   actual digest, DB target/schema/grants, TLS/DNS and global CLOSED. Check all
   public/legacy routes, not just a successful HTTP response or form disabled UI.
5. With synthetic adapters and deny assertions, prove direct POST /orders,
   retained legacy API, stale pages/links and direct canary calls cannot initiate
   a payment while globally CLOSED. Missing config refuses admission. Live
   read-backs must not create a bank/Refref order or rewrite old test rows.
6. On failed acceptance, reverse the approved route to the frozen static target
   (or maintenance page), keeping Commerce/canary admission CLOSED. No writers
   resume. Preserve new DB state/keys; repair/recover SSR separately. A static
   route fallback cannot count as successful new-DB recovery or legal acceptance.
7. After successful switch read-back, revoke only owner-approved retired PAT/S3
   writers whose consumer independence and new-stack recovery are demonstrated.
   Do not delay an unused writer key solely for a restore of the old site; equally,
   do not revoke a shared/unclassified key. Record changed authority and refresh
   applicable custody after revocation so recovery reflects the retired state.
8. Accept the SSR window, then retire the old static target and later the stand-in
   with their own recorded conditions/GO. Capture installed receipts under
   TOUR-67/VPS-15. No clean drift/fresh capture/restore proof means CUSTODY_PENDING,
   never an implicit acceptance. Native sales remain CLOSED.

## Legacy media and evidence retention

Keep the 26 legacy current objects pending an approved disposition. Needed media
is uploaded anew with rights through TOUR-63 stage 1; the old video is outside
the image pipeline. ZERO_IMPORT does not stop anonymous reads of legacy URLs.
GetBucketVersioning AccessDenied leaves versions/delete markers unknown.
TOUR-63/68 must qualify noncurrent versions, retention/backups and cached access
before any later erasure claim. No object/policy deletion or privilege expansion
is authorized. Preserve the four test payment/refund and legal/fiscal histories.
