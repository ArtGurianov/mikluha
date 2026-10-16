# ADR v2.2 — Immutable published departures and manual serialized site publication

- **Status:** Proposed; owner-confirmed direction, implementation and merge require review
- **Date:** 2026-10-16
- **Supersedes:** the `offers/offerRevision`, `departure_contract_version`, `SYSTEM_RELEASE_HOLD`, `DEPARTURE_ADMIN_PAUSE`, automated publish queue, full-descriptor promotion CAS, nightly scheduler and `SOLD_OUT` release machinery proposed in [ADR v2.1](./2026-10-16-control-room-hard-cut.md). The per-departure sales switch is the existing `bookingStatus` only. ADR v2.1 remains in Git with an explicit partial-supersession header, not a silently rewritten decision.
- **Retains:** PostgreSQL single mutable authority, migrations from `0008+`, SSG/Nginx, independent Commerce/Refref and immutable orders/legal evidence, Admin API segregation + MFA/OWNER legal release approval, cloud.ru S3/privacy go-no-go, no default YAML import, noncustodial payments, no CRM or raw tourist PII in Admin, global CLI-only reopen and recovery gates.
- **Planning:** existing Linear M11/M12/M13 workstreams; no new epic required.

## 1. Context

The tour operator expects editorial changes **approximately monthly**, not continuous repricing. No automated midnight/site inventory publication is required. The full v2.1 publication coordinator (queue, automatic candidate rebase, offer price handshake, special system release hold, full-site descriptor CAS and SOLD_OUT snapshots) is disproportionate to this operating cadence.

Existing Commerce already checks `DEPARTURE_STARTED` at booking time and serializes reservations with an advisory transaction lock keyed by departure; its current catalog reads YAML and `writeZayavka` reads the current departure at payment time. The hard cut must replace that mutable source with immutable resolved departure data, and preserve the legal and fiscal reservation/payment requirements.

## 2. Decision: two entities, one immutable commercial offer per published departure

**Tour** is a reusable editorial/template entity. **Departure** (event, `unitRef = departureSlug`) is the separately identifiable public commercial offer. The first *public publication* of the departure seals its contractual facts **even when zero orders exist**.

At this first publication, the server resolves the complete tour defaults and any **whole** departure product override (never a field-by-field merge), validates the actual inputs, and persists directly on the departure:
- **All fields** represented by `TourContract` (destination, route, program, included/excluded, insurance, risks) and `DepartureContract` (times/points, actual accommodation/registry facts, carrier, services) in `commerce/src/catalog.ts`, plus dates, time zone, tour/unit identity and the complete price in integer kopecks.
- An immutable `published_offer_snapshot` (or equivalent columns/JSON with schema validation, SHA-256 evidence and frozen `published_at`). This is **the contractual object** referenced by checkout and later Zayavka. A separate `departure_contract_version` table is unnecessary **because this object cannot be updated after its first publication**. Do not implement v2.1 mutable offer revision promotion.
- Database-enforced update/delete protection for all frozen fields, including the snapshot, slug/unitRef, tour binding, start/end dates and `published_at` (no reset-to-draft loophole). Enforce via migration, role privileges and transition constraints/trigger; not only a disabled Admin form. **Published departures are never physically deleted** while their order/history links may exist. Order FK uses `ON DELETE RESTRICT` or equivalent protection.
- The departure page and the booking/contract generator use **this exact sealed departure snapshot**, not mutable Tour fields nor a mutable fallback. A later Tour template edit changes **only future departures**. A shared Tour page must not silently claim that an existing departure has new contractual conditions; any per-departure displayed program/route must render from its own frozen snapshot.
- Retain source provenance, saved immutable unit price/amount, legal consent/terms and complete order-specific Zayavka; `writeZayavka` must never resolve the current editable tour to finish an older order. The paid Zayavka and immutable Refref/fiscal snapshots remain subject to existing safeguards.
- Editorial-only fields (images, marketing copy that does not change consumer product characteristics, SEO, reviews) can be edited and published **with sales open**. A marketing edit must not contradict the immutable description of the product. Legal artifacts (terms, PD consent, refund/payment rules) retain separate OWNER-only release control and live legal admission; they are **not** casually reclassified as harmless copy.

A new commercial price or material correction requires **a new departure record with a different slug/unitRef**, normally created through an Admin **Clone departure** action. No published `price` edit, `offerRevision` price confirmation, post-publication contract replacement, or mutable reference-to-tour escape hatch exists.

## 3. Replacement and cancellation

- If the original published departure **never concluded a contract** and there are no active reservations or unresolved payment outcomes, replace it by **setting `isListed=false` and `bookingStatus=CLOSED` in the same guarded transaction** (do not mark `CANCELLED` solely because of replacement). The old immutable row/slug remains for audit, direct-link fail-closed and referential integrity. A new copied departure gets a new slug/unitRef and starts closed.
- If concluded/paid contracts exist, replacing the public listing does **not** eliminate duties. Use a controlled **CANCELLED** workflow only with verified lawful grounds, client notices, EIS/provider effects, refund/read-back evidence and possible damages. Cancellation and refund are **not** a routine repricing tool. Obtain legal approval for the detailed cancellation procedure.
- **Never permit cancellation while `PAYMENT_PENDING` or `HELD` outcomes remain unresolved** (or any other ambiguous in-flight provider attempt); reconcile payment truth via Refref read-back first. A currently valid `RESERVED` seat also must be dealt with explicitly before replacement/cancellation; never treat its absence of a paid contract as evidence that no buyer is in progress.
- No mutation/deletion of completed payment, concluded agreement, provider/evidence or EIS history. `CANCELLED` is business status; `isListed` controls site visibility, and hiding alone must prevent **new** checkout, irrespective of stale static HTML.
- Russian regulation: Government Decree **13.05.2026 No. 551** on tourist-product services has applied since **01.09.2026**; actual grounds and consumer obligations under law No. 132-FZ and consumer law require a separate reviewed runbook, not an automatic refund-only assumption.

## 4. Admission, locks, batch close and capacity

**Exactly two persisted sale-control levels:**

1. Per departure, the sole mutable commercial admission state is **`bookingStatus` = `OPEN` / `CLOSED` / `CANCELLED`**. There is **no** independent `DEPARTURE_ADMIN_PAUSE`, `saleAdmission` field or `SYSTEM_RELEASE_HOLD` (nor a hidden pseudo-state). `isListed` remains a separate public-visibility control: `OPEN` and `isListed=true` are both required for admission. All status transitions and visibility changes are audited and DB-guarded; they are not ordinary CMS publication fields.
2. Existing **`GLOBAL_OPERATOR_STOP`** remains the absolute emergency/operator gate and can be reopened **only by privileged `commerce_operator` CLI**. Admin never receives that privilege, directly or via an alternate function. Closing an individual departure does not change this global gate.

**Transition authority:** Only **OWNER** may switch `OPEN ↔ CLOSED` through the isolated Admin API under the shared departure lock and live DB validation; the request to set `OPEN` verifies that the departure was first published with an immutable offer, the exact site URL and legal identities passed live HTTP read-back, it is `isListed=true`, it has not started, capacity/contract facts are valid and the global stop is not bypassed. `CANCELLED` is a one-way transition made only through the separately qualified cancellation workflow; neither OWNER nor a bulk restore can casually return it to `OPEN`/`CLOSED`. The website's SSG content cannot write `bookingStatus`; editor publishing `OPEN` text is incapable of opening sales.

**Single-departure "Pause sales":** OWNER changes `bookingStatus: OPEN → CLOSED`; **"Resume sales"** means `CLOSED → OPEN` after the same admission checks, **not** clearing a second pause flag. Creation of new departures always sets `CLOSED` regardless of draft/publication state.

**Batch "Pause all departures":**
- In **one PostgreSQL transaction**, take an **exclusive batch status-transition advisory lock** shared with every `CLOSED → OPEN` operation; lock the applicable **currently OPEN** departure rows in a deterministic order under the same per-departure locking protocol used by reservations/new payment initiation.
- Change only the selected `OPEN → CLOSED` departures atomically, and record an auditable batch-operation ID, exact IDs changed and their status-transition generation/version. All-or-nothing commit: external checkout observes either the prebatch admission or CLOSED after the committed change, never a partially applied set of updates.
- **No special fencing of newly created departures is needed**: DB initializes them CLOSED. However, concurrent attempts to **open** any departure must acquire the same batch advisory lock and serialize against batch close. This is a short-lived transactional lock, **not** a new persistent global stop.
- **"Resume this batch"** is a separate OWNER action, not automatic on website publication: inspect the recorded IDs and reopen **only those still CLOSED whose last status transition is the matching batch close**, after revalidating live-page/legal/capacity, started-date, isListed and the global operator gate. Do not reopen departures independently closed afterward, newly created departures, CANCELLED, hidden/unqualified departures or all CLOSED departures. An eligible subset may reopen transactionally or the whole restore fails with a clear conflict; never silently broaden its set. Keep batch records for audit, not as a second admission field.

`POST /orders`, **new** payment initiation (`POST /orders/<ref>/pay` and its transition), OWNER `OPEN/CLOSED` transitions, capacity change, operator reserve and cancellation use the **same departure transaction lock protocol** and reread actual state and current seat commitments **inside** the transaction. Global operator stop and `bookingStatus` are checked there, not from stale YAML/runtime cache or the static site. A close prevents subsequent new reservations and new payment initiation after its commit; already-issued provider sessions and Refref read-back/reconciliation continue independently.

**Capacity changes need no pause.** Under the same lock/transaction, refuse capacity below seats already committed/taken (including `PAYMENT_PENDING`, `HELD` and valid `RESERVED`, along with applicable paid/fulfilled obligations); concurrent reservation/capacity edits cannot oversell. No automatic `SOLD_OUT` persisted status. Operator reserve uses the same transaction lock.

**Cancellation uses the same lock and stronger predicates:** refuse unresolved `PAYMENT_PENDING`/`HELD` or ambiguous provider attempts, active valid `RESERVED` and unqualified concluded-contract cases. Require reviewed owner/legal workflow; do not conflate `CLOSED` or `isListed=false` with lawful cancellation. A batch close never cancels concluded contracts. Publishing harmless editorial content requires **no CLOSED transition**. No automatic global stop/reopen or sale-state changes arise from building the static site.

## 5. Static publication: one job, not a service orchestration subsystem

- A human explicitly starts **Publish** in Control Room; approximate cadence monthly. No scheduled midnight deployment, no `SOLD_OUT`-triggered publication, no price revision activation protocol, no queued derived releases or automatic rebase. There is no need for multiple concurrent publishing workers.
- A **single owner-hosted publishing job** obtains an exclusive publication/deployment lock **for the entire operation**: resolve the most recent *approved* public-safe PostgreSQL projection, validate full private graph without exporting hidden content, seal a hash-addressed public JSON artifact in cloud.ru S3, build Next.js SSG with pinned artifact/code inputs, verify candidate static output and `/release.json`, switch exactly the checked candidate image and read back the live result. On failure or any external/unexpected live-state change, **fail visibly and retry manually from current state**. Never silently publish a stale candidate. Do not require full-descriptor auto-CAS, queue/rebase worker, or an automatic repair loop.
- Publication lock and deploy ownership are mandatory: code deploys and Admin-triggered publishes use **the same exclusive lock**; **disable Coolify website auto-deploy** so an ordinary Git push cannot switch the site outside the job. The one current release/code input is fixed during each job. If Coolify cannot provide immutable per-build inputs and exact-image promotion safely, ART-360 proves an owner-built image pinned by digest before adoption; no non-atomic app-wide env update followed by a separate deploy.
- Public content snapshot remains minimal/PII-free, with only fully visible fields and safe hidden reference stubs, per ADR v2.1 security rules. Legal hashes are checked against Commerce as before. Independent Admin API, MFA and OWNER-only legal publishing remain.
- **No scheduled stale-departure rebuild.** The browser can hide/disable booking affordance for a past start date using a specified IANA time zone and current client time, with no per-visit Commerce request. This is only a UX hint (client clock may be wrong); Commerce's server-side `bookable()` already returns `DEPARTURE_STARTED` and is the authoritative gate. Accept that static SEO/HTML may be stale until manual publication; it must not allow a paid booking.
- **No automatically rendered SOLD_OUT in static SSG** and no dynamic per-view Commerce inventory requests. The Commerce form/checkout reports current availability after the transactional check. Do not store or edit `SOLD_OUT` in `bookingStatus` (`OPEN/CLOSED/CANCELLED`).
- No blanket sales pause is required for publication of harmless copy. **Publishing a new departure never itself opens sales**. After successful read-back, OWNER separately enables that departure under its atomic admission gate.

## 6. What changes versus ADR v2.1; what stays

| Area | ADR v2.1 plan | This ADR v2.2 decision |
| --- | --- | --- |
| Price | staged `offerRevision`, stale/future price confirmation | price locked at first public departure publication; new departure for new price |
| Contract | separately versioned `departure_contract_version` | resolved immutable snapshot stored on published departure, protected against update/delete |
| Template | published departure can resolve mutable Tour | inheritance resolves **once** at first publication; later Tour edits apply only to future departures |
| Publisher | queue, CAS, automatic rebase, bounded mismatch repair | **one** exclusive job, fail/manual retry, no background schedule |
| Release state | `SYSTEM_RELEASE_HOLD` plus operator/admin holds | **only** per-departure `bookingStatus` OPEN/CLOSED/CANCELLED + independent emergency CLI GLOBAL_OPERATOR_STOP; no per-departure pause field |
| SOLD_OUT | dedicated derived occupancy release | no automatic static SOLD_OUT release; server-side capacity remains authoritative |
| Capacity | potential critical Admin change | transactional under departure lock; no pause required |
| Sale readiness | cross-published price activation | new CLOSED departure: live page read-back then explicit OWNER open |

Unchanged: forward `0008+` migrations and immutable migration history, no default YAML backfill, SSG/Nginx, no per-visitor Commerce calls, Refref read-back/payment truth, immutable order/Zayavka/legal evidence, operator EIS attestation, restrictive role grants and Admin security, separate Cloud.ru S3 media pipeline, optional legally qualified TurboFlare, signed PD-REFREF-1/guest-house registry/first-sale blockers, restore/PITR, no automatic sales opening.

The prior ADR remains a historical decision, but **implementation tickets must follow this superseding ADR** for these topics. `DECISIONS.md` references should reflect that both ADRs are planning-only until actual hard cut; existing deployed Sveltia remains current until migration.

## 7. Acceptance / negative tests

1. Publish departure from a Tour template and full departure override: save exact resolved `TourContract`/`DepartureContract`, dates, zone, slug/unitRef and price; mutate the Tour later and prove existing departure page/contract/Zayavka unchanged. New departures pick up new Tour template.
2. Try to UPDATE immutable published price, contract, dates, slug, origin Tour binding, published_at reset or DELETE using Admin API and direct DB credentials: both reject, even with zero orders. Admin Clone makes a new CLOSED departure with new slug/unitRef.
3. Replace a departure without **any concluded contracts or active/ambiguous orders**: under departure lock atomically set **`bookingStatus=CLOSED` and `isListed=false`**; old slug remains unbookable with intact references/history; it does **not** become CANCELLED. A concluded-contract cancellation goes through separately qualified owner/legal workflow.
4. Refuse cancellation with outstanding `PAYMENT_PENDING`, `HELD`, ambiguous Refref read-back or valid RESERVED seats. Late provider success after a `bookingStatus=CLOSED` transition is reconciled, not silently dropped.
5. In concurrent `reserve`/pay/OPEN↔CLOSED/resize/operator-reserve operations, all use the same departure locking protocol and current DB state; never admit an oversell or new payment initiation after a committed `bookingStatus=CLOSED`. No second per-departure pause state exists; ordinary content publication cannot change bookingStatus.
6. **Pause all** in one transaction: atomically move currently OPEN → CLOSED, recording exact departure IDs and status-transition generations in an audit batch. No intermediate partial state; a concurrent **OPEN transition** serializes behind the batch status lock, but creation of a new CLOSED departure needs no extra fence. OWNER **Resume batch** affects only still-CLOSED, last-changed-by-this-batch eligible departures, never manually closed/CANCELLED/unlisted/new departures. CLI-only GLOBAL_OPERATOR_STOP still blocks all sales.
7. Increase/decrease capacity without setting bookingStatus=CLOSED; reject decrease below current taken seats and preserve hold/expiry rules under concurrent reservations.
8. Publish only noncontractual images/SEO/copy while existing departures remain sellable; verify unchanged offer snapshots and legal admission. Attempt to change contractual route through shared Tour description used on old departure is rejected/rendered from immutable snapshot.
9. Publish a new CLOSED departure, verify its exact live URL, content, contract identity and legal refs via HTTP; only then enable its sales. A stale static link after `isListed=false` cannot reserve.
10. Repeat manual Publish and code deploy concurrently: second job is serialized/rejected by the same exclusive lock. Failures do not promote a stale image or open sales; human re-runs from current state. Coolify auto-deploy and hosted Actions cannot bypass publisher.
11. No overnight/nightly `publish.yml` or inventory-driven SOLD_OUT deploy; past departure is rejected by server regardless of stale static page/client clock. Browser may hide the expired button without contacting Commerce.
12. One reserved order later written as Zayavka still uses the published immutable departure snapshot and legally accepted terms, unaffected by Tour/template changes; provider/Refref immutable payment snapshots pass existing tests.
13. Existing disaster recovery/0007+ owner-controlled proof, merchant admission, refunds/EIS and all first-sale gates remain CLOSED until separately cleared.

## 8. Risks and consequences

- Even a typo in a sealed accommodation address requires unlisting/replacing the departure; deliberate operational friction is accepted.
- Editorial content may get out of sync with static pages for weeks; checkout fails closed independently. Do not promise live countdown/inventory on SSG.
- Site publication and DB do not form a distributed atomic transaction: explicit new-departure CLOSED-before-publication and read-back-before-open remove the commercial mismatch that v2.1 solved with price revisions. Emergency loss of the published site requires owner action; no promise of automatic rollback.
- One publisher is a simple serialized command/job rather than a high-availability queue; stuck lock recovery and exact image integrity remain documented.
- Legal effects of operator cancellation are **not** reduced to automatically refunding the price. The cancellation runbook must be qualified separately against No. 551, No. 132-FZ, contract terms and provider/EIS obligations.

## 9. Execution map

- ART-357/358: freeze departure contract facts at first publication, distinct DB grants, snapshots and no-deletion/immutability barriers, with **bookingStatus-only per-departure admission**, batch-close audit and transactional capacity support.
- ART-359: retain legal/code/content compatibility and simplified static-site admission, remove offerRevision price handshake.
- **ART-360 (first: Coolify PoC):** build immutable public S3 export, DTO parity and **manual single publishing job**. Absorb ART-361 scope; no timer, automatic rebase, multi-job coordinator or inventory releases.
- **ART-361:** superseded and consolidated into ART-360; mark canceled as planning duplicate (not done/implemented), remove blocking relations in downstream tasks.
- ART-362: admission for immutable per-departure contract and payment, preserve frozen order/Zayavka; remove stale-price buyer reconfirmation mechanics.
- ART-365/366: clone and publish new CLOSED departure, immutable fields, OWNER OPEN/CLOSED controls and one-transaction **batch OPEN→CLOSED with selective batch restoration**, exact locking for checkout/pay/cancel/capacity; no DEPARTURE_ADMIN_PAUSE.
- ART-367/368: disable Coolify auto-deploy, retire GitHub/Sveltia publishing, exact-image tests and locked owner-approved hard cut. None of this authorizes opening sales.
