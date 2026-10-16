# ADR v2.2 — Immutable published departures and manual serialized site publication

- **Status:** Proposed; owner-confirmed direction, implementation and merge require review
- **Date:** 2026-10-16
- **Supersedes:** the `offers/offerRevision`, `departure_contract_version`, `SYSTEM_RELEASE_HOLD`, automated publish queue, full-descriptor promotion CAS, nightly scheduler and `SOLD_OUT` release machinery proposed in [ADR v2.1](./2026-10-16-control-room-hard-cut.md). ADR v2.1 stays in Git as a record of the earlier decision, not as the active implementation plan for those topics.
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

- If the original published departure **never concluded a contract** and there are no active reservations or unresolved payment outcomes, replace it by **setting `isListed=false` and sale-admission CLOSED** (do not mark `CANCELLED` solely because of replacement). The old immutable row/slug remains for audit, direct-link fail-closed and referential integrity. A new copied departure gets a new slug/unitRef and starts closed.
- If concluded/paid contracts exist, replacing the public listing does **not** eliminate duties. Use a controlled **CANCELLED** workflow only with verified lawful grounds, client notices, EIS/provider effects, refund/read-back evidence and possible damages. Cancellation and refund are **not** a routine repricing tool. Obtain legal approval for the detailed cancellation procedure.
- **Never permit cancellation while `PAYMENT_PENDING` or `HELD` outcomes remain unresolved** (or any other ambiguous in-flight provider attempt); reconcile payment truth via Refref read-back first. A currently valid `RESERVED` seat also must be dealt with explicitly before replacement/cancellation; never treat its absence of a paid contract as evidence that no buyer is in progress.
- No mutation/deletion of completed payment, concluded agreement, provider/evidence or EIS history. `CANCELLED` is business status; `isListed` controls site visibility, and hiding alone must prevent **new** checkout, irrespective of stale static HTML.
- Russian regulation: Government Decree **13.05.2026 No. 551** on tourist-product services has applied since **01.09.2026**; actual grounds and consumer obligations under law No. 132-FZ and consumer law require a separate reviewed runbook, not an automatic refund-only assumption.

## 4. Admission, locks, pauses and capacity

Keep `GLOBAL_OPERATOR_STOP` as the separate **absolute** operator/failsafe switch, re-openable **only through the privileged `commerce_operator` CLI**. Do not grant Admin an indirect global reopen path.

Use one per-departure `DEPARTURE_ADMIN_PAUSE` with audited OWNER/Admin operations:
- Admin **Pause departure** sets the per-departure pause.
- Admin **Pause all departures** sets the same pause for the complete applicable set **in one DB transaction**, after taking the appropriate global/collection gate plus deterministic per-departure locks, so **no new reservation/payment initiation can slip in between rows**. Concurrent creation/opening of new departures must also be fenced by the batch gate/locking protocol. This is a batch operation, not a new persistent fourth global stop.
- Only authorized OWNER Admin clears Admin pauses, per departure or as reviewed batch; it cannot bypass `GLOBAL_OPERATOR_STOP`, legal gates, readiness, `CANCELLED`, sold capacity or an unresolved payment.
- `POST /orders`, new payment initiation (`POST /orders/<ref>/pay` and its server-side transition), pause/unpause, capacity change, operator reserve and cancellation use the **same departure transactional lock protocol**. After acquiring the lock, reload the current DB row/status/availability, not a stale YAML/in-memory copy; check global and per-departure gates **inside** the transaction. Preserve already-issued payment attempts and read-back reconciliation when sales pause.
- **Capacity edits need no Admin pause.** Inside the same departure lock/transaction, reject values below the authoritative seats already committed/taken (including `HELD` and `PAYMENT_PENDING`, and valid `RESERVED` by current expiry semantics), and prevent concurrent overselling. Operator reserve also uses these locks. Capacity itself is not frozen contractual snapshot.
- **Cancellation uses the same lock and stronger predicates:** block when unresolved payment, outstanding valid reservations, inconsistent provider evidence or legally unqualified existing contracts. Require an explicit workflow and auditable decision. Do not allow `isListed`/status writes to bypass it.
- An Admin pause is required for explicit exceptional operations which affect whether a departure may sell, **not** for publishing harmless editorial changes or safely updating capacity. There is no separate `SYSTEM_RELEASE_HOLD` or routine global pause around site publication.
- Initial state of a newly created departure is **CLOSED / not sellable**. OWNER may enable sales only **after** the relevant static public page, exact slug and offer/terms identities are verified at the live site and all independent admission gates pass; the global CLI stop still wins.

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
| Release state | `SYSTEM_RELEASE_HOLD` plus operator/admin holds | remove SYSTEM_RELEASE_HOLD; per-departure Admin pause + distinct emergency CLI global stop |
| SOLD_OUT | dedicated derived occupancy release | no automatic static SOLD_OUT release; server-side capacity remains authoritative |
| Capacity | potential critical Admin change | transactional under departure lock; no pause required |
| Sale readiness | cross-published price activation | new CLOSED departure: live page read-back then explicit OWNER open |

Unchanged: forward `0008+` migrations and immutable migration history, no default YAML backfill, SSG/Nginx, no per-visitor Commerce calls, Refref read-back/payment truth, immutable order/Zayavka/legal evidence, operator EIS attestation, restrictive role grants and Admin security, separate Cloud.ru S3 media pipeline, optional legally qualified TurboFlare, signed PD-REFREF-1/guest-house registry/first-sale blockers, restore/PITR, no automatic sales opening.

The prior ADR remains a historical decision, but **implementation tickets must follow this superseding ADR** for these topics. `DECISIONS.md` references should reflect that both ADRs are planning-only until actual hard cut; existing deployed Sveltia remains current until migration.

## 7. Acceptance / negative tests

1. Publish departure from a Tour template and full departure override: save exact resolved `TourContract`/`DepartureContract`, dates, zone, slug/unitRef and price; mutate the Tour later and prove existing departure page/contract/Zayavka unchanged. New departures pick up new Tour template.
2. Try to UPDATE immutable published price, contract, dates, slug, origin Tour binding, published_at reset or DELETE using Admin API and direct DB credentials: both reject, even with zero orders. Admin Clone makes a new CLOSED departure with new slug/unitRef.
3. Replace a departure without **any concluded contracts or active/ambiguous orders**: atomically CLOSE and `isListed=false`; old slug remains unbookable with intact references/history; it does **not** become CANCELLED. A concluded-contract cancellation goes through separately qualified owner/legal workflow.
4. Refuse cancellation with outstanding `PAYMENT_PENDING`, `HELD`, ambiguous Refref read-back or valid RESERVED seats. Late provider success after a pause is reconciled, not silently dropped.
5. In concurrent `reserve`/pay/pause/resize/operator-reserve operations, all use the same departure locking protocol and current DB state; never admit an oversell or payment initiation after a committed pause.
6. **Pause all** in one transaction: no intermediate window or new departure creation bypass. OWNER unpauses only Admin pauses; CLI-only global operator stop still blocks all sales.
7. Increase/decrease capacity without Admin pause; reject decrease below current taken seats and preserve hold/expiry rules under concurrent reservations.
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

- ART-357/358: freeze departure contract facts at first publication, distinct DB grants, snapshots and no-deletion/immutability barriers, with transactional holds/capacity support.
- ART-359: retain legal/code/content compatibility and simplified static-site admission, remove offerRevision price handshake.
- **ART-360 (first: Coolify PoC):** build immutable public S3 export, DTO parity and **manual single publishing job**. Absorb ART-361 scope; no timer, automatic rebase, multi-job coordinator or inventory releases.
- **ART-361:** superseded and consolidated into ART-360; mark canceled as planning duplicate (not done/implemented), remove blocking relations in downstream tasks.
- ART-362: admission for immutable per-departure contract and payment, preserve frozen order/Zayavka; remove stale-price buyer reconfirmation mechanics.
- ART-365/366: clone and publish new CLOSED departure, limited immutable fields, single-row and one-transaction mass Admin pause, exact locking for checkout/pay/cancel/capacity.
- ART-367/368: disable Coolify auto-deploy, retire GitHub/Sveltia publishing, exact-image tests and locked owner-approved hard cut. None of this authorizes opening sales.
