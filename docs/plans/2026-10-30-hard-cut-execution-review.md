# Mikluha SSR/Admin hard cut — execution review, revision 4, 2026-10-30

Status: review draft, incorporating both rounds of OPUS and GPT reviews. This is an
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

## Two production phases: installation/data entry and public traffic

**Phase A — authorized installation, then restricted Admin/data entry.** Public
traffic remains on the existing site. The installation GO must name its technical
staging and real-use boundary. A0 permits only the specifically approved empty
DB/schema/config installation and isolated/synthetic validation, with production
Admin origin inaccessible to users and no real Admin accounts/content/legal
records entered. No technical staging permission is inferred from this draft.

Before A0, qualify exact-source logical/PITR recovery in an isolated environment
and approve the drift route and installation scope. After the explicitly approved
empty target exists, verify its real backup target/stream/read-back and actual
installed schema/role/recovery correspondence. Stop at the A-READY boundary until
all A requirements below pass. This avoids pretending an uninstalled target can
already have an installed backup receipt, or allowing real Admin data before
recovery proof. Initial real owner enrolment itself is a real-data operation.

A-READY admits protected Control Room use: actual admin identities, sessions,
audit/logging, editorial content and legal preparation. Its privacy/access,
backup/recovery, key and drift gates must already be satisfied. Use first-approved
actual flows: private media staging is permitted only in approved scope; exposing
public variants during A requires their public-media/rights/privacy approval at
that time, not postponed to B. Sales and provider initiation stay globally CLOSED.

**Phase B — separately authorized public traffic switch.** SSR receives public
traffic only after B-READY, while Admin gates from A remain valid. Active legal
versions/public rendering, public logs/media/privacy, all-path CLOSED, scoped
canary deny and fallback receipts must be accepted. No whole native checkout,
Refref v10 or optional image-cache completion is required.

The phase A GO and phase B GO are distinct authorizations, possibly within one
maintenance window. A's permission does not authorize B; B cannot retroactively
supply missing Admin/data-entry approval. A-READY is an evidence condition inside
the named owner scope, not an automatic extra GO or permission from a status.

## Required gates by phase

| Gate | Earliest required boundary | Evidence / owner |
|---|---|---|
| Relevant inventory; retained old/test/legal evidence | Before A installation; refresh before B | TOUR-82-A, no whole TOUR-82-B prerequisite |
| Source/images/schema/roles selected; isolated exact-source recovery proven | Before authorized A0 installation | TOUR-60::SSR_SOURCE_READY, TOUR-17/57, VPS-15; no production restore rehearsal |
| Overall drift route and installation manifest | Before A0; revalidate after changes and before B | VPS-15/shared host owners; overall PASS by default, explicit accepted exception only |
| Real target backup + logical/PITR correspondence + matching key recovery | A-READY, before first real Admin/content/legal write | Actual new DB identity/streams/roles; independent read-back/recovery, fresh custody as required |
| Admin slice of SSR_PRIVACY_READY and restricted Admin origin | A-READY, including first owner enrolment | TOUR-68/64, VPS-15: identities, sessions, audit, IP/logs, access controls and retention |
| Source-ready Control Room and SSR-control/capacity slice | Before A-READY for the functions admitted there; full switch scope before B | TOUR-64/66, proposed TOUR-65 SSR stage: OWNER control, atomic locks/capacity, no oversell |
| New media pipeline, approved rights/private originals/bounded transform | Before use in A; public delivery approval before first exposure in A or B | TOUR-63 stage 1; ZERO_IMPORT |
| Versioned legal publication and public legal-page parity | Before B-READY, plus any earlier real publication in A | TOUR-58/59: termsRef/version/hash/effective date/approval |
| Public SSR/log/media slice of SSR_PRIVACY_READY | Before B-READY, or earlier exposure of each flow | TOUR-68; do not defer already active Admin/media processing |
| Global CLOSED and provider initiation denied | A0 onward for new stack; all-path switch acceptance at B-READY | TOUR-67 UI/API/legacy/stale paths, missing config fails closed |
| Scoped CANARY_PAYMENT_DENIED | Before B, or start of its explicitly authorized window | REFREF-125 separate GO; no live create/refund probe |
| Approved static fallback or maintenance page; exact traffic manifest | B-READY | TOUR-67/VPS-15; no writers, no restored legacy payment admission |

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
new legal determination. The static site already using the same host is relevant
baseline evidence, but not proof that new Admin/logging flows are unchanged.
A no-regression comparison is an input to the review; it does not resolve an
unknown recipient/access path. Current TOUR-68 acceptance is not weakened here.

## Explicit proposals requiring owner acceptance before use

- **Old DB preservation:** reduce the pre-switch old-database rehearsal to one
  encrypted consistent logical dump, checksum/off-host retrieval/readability,
  required configuration/key references and an untouched original DB/volume.
  This avoids a separate old-schema restore rehearsal when it is not a fallback
  write target. Include inspection of dump contents and the documented restore
  procedure; a checksum alone is insufficient. It is a proposal requiring formal
  scope approval, not a waiver of TOUR-17/57/VPS-15 acceptance.
- **Target recovery:** retain the existing logical restore and physical PITR
  gate. Revision 2's optional deferral is withdrawn from the recommendation:
  Control Room users, content and legal records may be created before traffic
  switching. Qualify the exact schema/recovery procedure in isolation before
  real production editorial/admin/legal data is entered; verify installed target
  backup identity and refresh proof for the actual release before cutover.
  A successful logical restore alone is not proof of physical PITR.
- **CUSTODY_PENDING:** a status is not permission to switch. External proof or an
  explicitly accepted recovery alternative must be in the exact owner manifest.
  The overall drift obligation below is separate from empty custody lists.
- **Temporary static fallback:** retain the frozen old public static container
  as a route-only fallback during SSR acceptance. This is a proposed recovery
  policy addition; it never restores Sveltia or any writer and needs explicit
  inclusion in switch GO. Confirm that its rendered policy/media/links remain
  acceptable; if not, use an approved static maintenance response instead.

## Recovery scope: logical database backups and cluster-wide PITR

A logical dump identifies the old or new database separately. Physical base
backup plus WAL describes the entire PostgreSQL cluster: old and new databases
share its recovery boundary if they share an instance. Do not label a physical
stream or PITR receipt as independently restoring only the new database.

The manifest records cluster identity, PostgreSQL/image version, base-backup
identity, WAL archive continuity/timeline and target time/LSN; map these to both
database names. Logical dump manifests retain their individual DB identities.
Demonstrate recovery in an isolated instance/volume with applications, jobs,
production ingress and outbound provider access disabled. Never restore a
rehearsal over production or mount its live data volume as a writable target.

After cluster recovery, verify the selected point, new DB schema, known fixture
state and role/grant separation, with paired encryption-key recovery where
needed. Demonstrate extracting the new database and its required roles/grants
from that recovered cluster into a separate isolated target; do not blindly
restore shared cluster globals over production. Returning a DB to production is
a different, explicitly authorized recovery operation. pg_dump readability or
successful restore proves logical recovery only, not WAL recovery/PITR. Preserve
the old DB separately; its presence in the same cluster is no independent copy.

References: [PostgreSQL 16 PITR](https://www.postgresql.org/docs/16/continuous-archiving.html)
and [pg_basebackup](https://www.postgresql.org/docs/16/app-pgbasebackup.html).
Cluster configuration files and application keys also need their owning recovery
route; physical data recovery alone is not complete runtime recovery.

## Overall VPS drift: an explicit owner decision, not a hidden cache dependency

VPS-17 media/cache admission remains deferred and non-blocking for direct-S3
SSR. Its consumer-specific checker is not the general SSR installation tool.
However, Mikluha's own AGENTS.md requires the infrastructure drift check clean
and a fresh capture before reporting this host change free of CUSTODY_PENDING.
Empty custody_refresh_required/custody_restore_unverified lists alone do not
prove the overall drift status PASS. VPS-16 retains historical custody/drift
follow-up; it is not automatically a formal whole-issue dependency of TOUR-67.

Before scheduling cutover, select one route in VPS-15/TOUR-67:

1. **Default under the present contract:** review/reconcile outstanding shared
   host drift under its owning tasks (including VPS-16), then obtain fresh overall
   PASS plus changed-resource capture/independent restore proof. Do not change
   the baseline merely to obtain PASS. Record classified findings, owners,
   remedial work and estimate before setting the window; no estimate is inferred
   from a count of differences.
2. **Only with explicit owner contract exception:** accept a dated scoped gate
   for this release while the overall host status stays REVIEW_REQUIRED. Specify
   exactly which AGENTS rule is excepted, affected resource IDs, shared dependency
   closure (DB/storage, backup/key authority, proxy/TLS, networks/DNS and platform
   services), reviewed residual drift and why it cannot invalidate the operation,
   required fresh capture/independent restore and a validity limit/requalification trigger.
   Obtain acceptance in the manifest and owning contract/Plane record; adapt and
   test the actual admission/checker only if required. Do not change a cache
   checker to bypass the general contract or report overall drift PASS.

A scope limited to files edited by this release is insufficient if shared
recovery/routing/credential dependencies remain unreviewed. Audit ciphertext
preservation is a different gate from operational host drift and recovery.

## Phase A installation manifest and phase B traffic manifest

No unresolved placeholders are allowed in the executable manifest for the scope
of each GO. Mark every resource/action A0, A-READY or B; phase-A operation cannot
wait for B privacy/recovery approval. This review chooses a preferred topology,
subject to the installation review:

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
   recipient/key recovery, timers and cluster-wide WAL/base-backup mapping. Verify a
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
   exceptions, including the chosen overall-drift route and disposition of each
   shared-host finding. Record A-READY and B-READY independently. No new bank/
   refund probe as a verification shortcut.
8. **Credentials:** consumer-by-consumer list for each proposed PAT/Sveltia S3
   revocation, evidence of no backup/new-media/shared consumer, owner approval,
   method of proving old write denial and recovery of the new stack without it.
   Do not use an unapproved upload/push to prove denial in production.

## Phase B owner-authorized traffic-switch window

1. Confirm A-READY/real-use receipts and B-READY prerequisites, then reconfirm
   inventory, exact manifests and global CLOSED. Unexpected operations
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
