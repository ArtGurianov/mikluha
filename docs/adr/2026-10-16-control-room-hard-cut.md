# ADR — Mikluha Control Room: unified PostgreSQL authority and Sveltia hard cut

- **Status:** Proposed for review (owner-approved direction; implementation and merge require independent review)
- **Date:** 2026-10-16
- **Repository baseline:** ArtGurianov/mikluha main at b44bfea795784275b3ca9cf3b6ed5ab4253020b2
- **Reference architecture:** ArtGurianov/flexperiment Control Room, editorial publication and static Admin (patterns only, not runtime/code dependencies)
- **Scope:** Content, Commerce, publishing, Admin, public media and future CRM boundaries
- **Planning authority:** Linear project mikluha-maklai.ru; this ADR owns normative decisions, not execution status

## 1. Context and decision

The current public website is a Next.js static export served by Nginx. Sveltia CMS is a static bundle that writes YAML to GitHub and media directly to cloud.ru S3. Site and mikluha-commerce read the same YAML source but bake it into independent builds. A price edit requires deployments, and the slice-4 LiveSiteReleaseAdmission compares the site release's source commit, termsRef/hash and pdConsentRef/hash to the Commerce image. This deliberately prevents silently drifting legal releases but couples unrelated editorial edits to sale admission.

The project is becoming an operating system for a tour operator: linked tours/departures, commercial offers and capacity, orders, EIS state, reviews/media and (later) CRM. Keeping Git/YAML as one active writer and Postgres as another would require continued synchronization, separate publication semantics and divergent admin permissions. There are no existing app customers or production Mikluha Commerce records requiring historical migration. Downtime during the cutover is explicitly acceptable.

**Decision:** permanently replace Sveltia with a first-party static Control Room UI backed by Mikluha's existing PostgreSQL/Commerce backend. PostgreSQL is the sole authoritative mutable store for content, commercial offers, capacity, order state, editorial revisions and media metadata. Admin is a UI, not an independent source of truth. Keep the public site SSG/Nginx and retain Commerce's independently verified Refref integration and operator safety controls. There is no dual-writer transition.

## 2. Accepted boundaries and non-goals

1. Continue PostgreSQL migrations after 0007 starting at **0008**. Never replace 0001–0007 with a new baseline or silently modify committed migrations. Existing schema-6 recovery evidence remains historical only; 0007 and later heads require new owner-authorized restore/PITR evidence. The current README says production Commerce is not deployed; do not mislabel test/Refref fiscal evidence as a live Mikluha production database.
2. Use the **existing** cloud.ru Evolution Object Storage for media; perform a TurboFlare CDN proof of concept first. No customer or order data may transit a public CDN.
3. Hard cut, downtime allowed, **no historical order/customer/payment backfill** and no default YAML import. Create current tour/departure content through Admin after installation; optionally develop a narrowly scoped, owner-reviewed editorial-only draft seed if genuinely needed. Do not bring demo/legal placeholders into a published offer.
4. No CRM tables, customer-identity accumulation, marketing campaigns, mailing automation or blanket new retention in v1. Current separation and erasure rules for order_contact and order_passenger remain intact. Future CRM must define its own purpose, legal basis, consent and retention before processing.
5. No browser-based EIS filing packet, passports, sales reopen or EIS_SUBMITTED write in v1. Existing privileged CLI stays the authority.
6. No direct runtime import of Flexperiment packages, its SQLite storage or payment authority. Reuse reviewed UX, typed API, idempotency, audit, draft/publish and static Admin architectural patterns.
7. Refref remains payment/attribution integration, not a second price list; Mikluha owns commercial price and orders.

## 3. System ownership

| Domain | Single authority | Public/read boundary |
| --- | --- | --- |
| Tour/destination, itinerary, reviews, reports, organizers, legal drafts | Mikluha PostgreSQL editorial tables | immutable published content release to SSG |
| Departure dates, resolved contract, accommodation and carrier | Mikluha PostgreSQL, versioned | published contract version; frozen reference per order |
| Departure offer price in integer kopecks and active offer revision | Mikluha PostgreSQL Commerce | immutable candidate/published releases; checkout authoritative |
| Capacity, admin reserve, seat commitments | Mikluha PostgreSQL Commerce | read-only summary in Admin; exact sale check inside DB transaction |
| Orders, payment truth reconciliation and fiscal/Refref snapshot | Mikluha PostgreSQL, verified against Refref read-back | no writable state in Admin |
| Tourist/contact PII | existing order_contact / order_passenger tables | never in CDN or generic Admin read API |
| S3 objects | cloud.ru S3 bytes; media_asset metadata in PostgreSQL | public processed variants only |
| Runtime code identity | immutable application image/build identity | separate from published content identity |

Stable immutable UUID primary keys should be used internally. Preserve the external tour slug, departure slug, source URLs and Refref mapping (**offerRef = tourSlug**, **unitRef = departureSlug**) where those are contractual/public interfaces. Slugs cannot be used to silently rewrite the identity of an already sold departure. Published links remain stable or receive an explicitly reviewed redirect.

The existing lib/cms/types.ts DTOs and normalization boundary (DECISIONS #6) remain the contract to website components. Implement a database-release-to-DTO adapter instead of rewriting the public UI; retire Raw YAML readers and their mirrored Sveltia schema only after parity. **isListed is fail-closed**: only explicit true publishes a document. Editorial visibility and commercial sale permissions remain independent (DECISIONS #8).

## 4. Offers, prices and static publication

**Source of truth:** the active published departure offer revision in PostgreSQL. No YAML price authority, no browser-supplied authoritative price, and no price duplicated in Refref.

An offer edit creates an immutable **candidate revision N+1**, not an immediate change to the active N. A publishing worker builds and tests the SSG output from an exact immutable **contentReleaseId** that references the candidate offer revisions and the appropriate legal refs/hashes. Publication writes a no-store **/release.json** with contentReleaseId, immutable offer-manifest digest (or explicit revision map), termsRef/hash, pdConsentRef/hash and a release schema. Separate immutable build/image identity remains available for provenance/compatibility; exact sourceCommit equality of site and Commerce must not be the content parity requirement after migration.

For the new revision:
1. Editor saves candidate; active N continues to sell.
2. Build SSG from immutable release, validate content/SEO/structured data, stage candidate and verify live /release.json read-back (noncached), including its offer revisions/digest and legal hashes.
3. Commerce activates N+1 **only after** site publication is confirmed. Activation is an audited, transactional revision update using expected current revision and idempotent publication intent. No git commit or manual deployment is needed for ordinary content/price edits.
4. A link on the static page includes the actual **offerRevision** for its departure. A request carrying an old revision is shown the current amount and an explicit price-change confirmation **before collecting passenger PII / reserving**.
5. A link bearing a **future** revision not yet active must not reserve seats at the old lower price; return a short temporary-unavailable state for that departure. There is no general operator/system pause for routine price publication.
6. The POST /orders transaction validates buyer-confirmed active revision **under concurrency control shared with activation** (e.g. locked row/advisory lock), capacity and sales guards before persisting unit price, amount, offer revision and contract version. GET-only checks or unsigned form hints are insufficient.
7. Existing RESERVED orders keep their frozen amounts and payment/reconciliation behavior, subject to existing legal-release gates. A change of price never retroactively changes an order or Refref snapshot.

A failed build **before public activation** leaves N active. A failure after public site cutover but before Commerce activation requires deterministic recovery (finish read-back/activation or republish previous site release); requests for unactivated future revisions fail closed. Publication job state, retry/replay keys and any stuck mismatches are observable in Admin and monitoring. Do not claim atomicity across DB and an external static deployment.

Public SSG HTML, price metadata and structured data must reflect the build's offer revision; buyer-facing Commerce always checks the current authority. Do not fetch price or seat counts from Commerce on every static page visit: preserve DECISIONS #5 (the public site does not send every visitor's IP to Commerce or collect app user data). The number of remaining seats is not advertised as real-time in HTML. A transition to SOLD_OUT may coalesce/debounce a refresh build to update a static status, but the website's status is informational: booking always rechecks the live database.

Keep the DECISIONS #7 scheduled refresh for departures that have begun, with the same protection against accidentally publishing saved-but-unpublished drafts. Scheduled builds use the **currently active published release**, not arbitrary drafts.

## 5. Immutable booking/contract binding

Create an immutable **departure_contract_version** (resolved itinerary, dates, time zone, departure/return points, actual accommodation, supplier, transport, inclusions/exclusions, risks and optional services). A whole per-departure product override replaces tour defaults; partial override does not merge/fall back, matching the existing contract invariant.

At reservation, save a foreign key **departure_contract_version_id ON DELETE RESTRICT** plus frozen active offer revision, unit price, dates/times/time zone, offer text and consent identities according to existing model. The contract version is append-only/immutable, never UPDATE to change sold conditions. A later revision creates a new row. The order and later writeZayavka use **that exact old contract version**, never the latest departure row; buyer/Refref monetary resolution and participants are added later to the order-specific Zayavka. The paid Zayavka remains immutable in order_document and remains subject to the existing legal retention / legal hold / erasure lifecycle. Contract versions may be retained indefinitely in v1; no new automatic deletion worker is required. Review supplier personal details and disclosure policy if applicable. **No cascade delete** of contracted versions.

Code-review tests must prove a reservation under contract v10 generates its Zayavka from v10 after content v11 has published, including the case where resolution happens later.

Do not change the current Refref handoff, referral resolution hash, one-attempt idempotency, read-back-driven PAID, payment snapshot/fiscal contract, EIS revision or refund qualification. Keep documented-expense refund workflow gated until independently qualified.

## 6. Inventory and three independent holds

Existing Commerce already computes taken seats transactionally from RESERVED, PAYMENT_PENDING, PAID, FULFILLED and HELD. Move only YAML **capacity** to DB authority and implement an audited operator/admin reserve, without duplicating committed-seat counts. Reserved-expiry and HELD restrictions remain.

Three independent blockers, never mapped to the same editable bookingStatus field:

| Hold | Set by | Clear by | Semantics |
| --- | --- | --- | --- |
| SYSTEM_RELEASE_HOLD | publishing/reconciliation pipeline only on exceptional inconsistent releases | pipeline only after exact read-back/recovery | not needed for normal price publication; alert if stuck |
| DEPARTURE_ADMIN_PAUSE | authorized OWNER/OPERATOR Admin | OWNER Admin (only this pause) | per departure; cannot open global sales |
| GLOBAL_OPERATOR_STOP | privileged CLI; Admin via special close-only DB capability | **only** CLI with commerce_operator login | absolute stop of new reservations and new payment initiation |

Preserve existing fn_set_sales_open and commerce_operator isolation. Introduce a separate narrow **close-only** DB role/function, auditable and impossible to use for open. Neither runtime commerce_app nor a stolen Admin session may call fn_set_sales_open or otherwise set global open=true. New opening through public API, changing bookingStatus, republishing a departure or clearing an Admin pause cannot bypass GLOBAL_OPERATOR_STOP. The runtime must check all independent admission conditions **inside** the reservation/payment transaction, at the appropriate locks; avoid creating a UI-only gate. Closing a departure is not equivalent to canceling already paid orders.

## 7. First-party Admin and security

Deploy a separately served **static Next.js/React Admin** (Nginx), using the Flexperiment Control Room as UX/API reference. Same-origin narrowly proxied admin paths to Commerce (no browser secrets and no cross-origin admin write). Backend enforces authorization, rate limits, anti-CSRF/Origin, bounded payloads, optimistic concurrency, idempotent write intents, no-store on sensitive API responses, HttpOnly/Secure/SameSite sessions, revocation and structured audit.

Admin areas required at cutover: Dashboard; Tours/destinations; Departures/events and their programs, actual pricing, capacity and published availability; Organizers; Media library; Reviews and trip reports; Site/legal content and preview; order/seat/financial **operational summaries**; EIS status-only; Audit; Settings and alerting. Allow the creation of new tours, departures, images, reviews, reports from Admin and publication without Git.

Do not expose passport details, EIS filing packets or raw order_contact/order_passenger to Admin v1. Any later sensitive PII viewer requires separately reviewed privacy/security scope (MFA/step-up, per-read audit, session safeguards and retention). CLI under commerce_operator remains the only means to reopen global sales or attest EIS_SUBMITTED. An owner access-recovery procedure must be documented; v1 does not require a new PII-viewer MFA subsystem.

## 8. Media and TurboFlare

Keep existing **cloud.ru S3**. Conduct an early, independent **TurboFlare CDN PoC** verifying external Evolution S3 origin compatibility, custom image host/TLS, MIME/CORS/Cache-Control, origin authorization/public read design, hit/miss, cache behavior, failure mode and recovery. Do not assume on-the-fly image processing, invalidation API or free origin egress without proof.

Upload **via a bounded authenticated backend endpoint**, not direct browser presigned PUT to a public bucket. Validate actual type, byte/pixel count and dimensions; isolate transforms in a constrained worker/process (memory/CPU/time limits; reject decompression bombs), strip EXIF/GPS, produce validated WebP variants. Originals live in a **private** prefix/access policy; CDN and public S3 may serve only processed immutable variants. Store asset UUID, private key, public variant keys, hash, dimensions, MIME, size, ownership/ref status and upload lifecycle in PostgreSQL. Disallow arbitrary user-controlled URL origins and unsafe SVG/HTML upload.

The site build-time **media resolver** chooses TurboFlare public variant URLs in normal mode. A documented, tested fallback toggles resolver to **direct HTTPS cloud.ru S3 variant URLs** and rebuilds the SSG; downtime of minutes is accepted. No always-on backup gateway or unverified DNS CNAME/TLS assumptions. Test reverse switch in PoC; do not make original private uploads public during fallback. Video remains a separately bounded existing WebM case until future independent qualification.

TurboFlare receives visitors' IP at its edge: review/update privacy disclosures, roles and regional data processing before production enablement, including Russian personal-data localization constraints where applicable.

## 9. Editorial model and website compatibility

Use content draft, published immutable release, validation errors, optimistic revision/CAS and publish audit. Site and booking/legal contract releases must carry matching release/terms/consent identities. A publication cannot imply opening sales; only published and explicitly listed entities appear publicly.

Preserve existing DTO semantics, URL/slug validation, markdown sanitization, SEO, sitemap, demo/launch readiness constraints, optional hero WebM and image-gallery limits until deliberately reviewed replacements. Use existing lib/cms/types.ts as the compatibility target; replace content/ -> sync -> normalize adapter with DB release -> normalize/DTO adapter. Remove Sveltia's browser PAT/secret and direct S3 credentials when cut over.

Explicitly supersede the CMS-specific aspects of DECISIONS #1 (Admin becomes own statically served application but still separate from public runtime), #2 (server-side image processing replaces no-processing), and #7 (publish and scheduled rebuild now use published DB releases). **Retain** #5 (no per-visitor Commerce request from static site), #6 (normalization/DTO boundary) and #8 (listed versus sale-status separation).

## 10. Cutover, operational evidence and recovery

Single-writer **hard cut**; no production use of Sveltia after the switch and no dual-writing migration. Build and test the new isolated stack with sales CLOSED. Create real reviewed catalog/legal values via Admin; no automatic import of obsolete/demo YAML. Preserve old Git commit, configuration documentation, nonsecret object inventories and historic test/provider evidence, but do not claim there is an existing Mikluha production customer ledger to migrate. Do not destroy/reforge signed evidence, backups or test fiscal records at Refref/provider.

At cutover: independently verify current site/Commerce release and legal identities, complete relevant owner-only migrations (including 0007), isolated logical/PITR restore evidence for the exact new schema, admin authentication and permissions, clean S3 upload/processed CDN variants/fallback, public SEO/links and Refref merchant compatibility. Close old Sveltia static bundle and related GitHub publication workflow/repository_dispatch, revoke scoped editor PATs and browser S3 credentials, and remove YAML price writers/runtime reads. The former Sveltia has **no server-side admin API** to shut down. Keep a rollback/recovery playbook: before first money one may redeploy known-good closed images; after real orders exist never roll back DB/checkout without payment truth reconciliation.

Hard cut does **not** authorize sales to open: retain blocked gates for signed PD-REFREF-1, guest-house registry/contract veracity, DOCUMENTED_EXPENSES refund qualification, production Refref conformance, current fiscal/provider admission, monitor and recovery evidence. Production Commerce currently undeployed according to its README; verify live state independently before operational action.

CI is currently local/self-hosted while hosted GitHub Actions minutes are exhausted (approximately until 2026-11-02); no “hosted green” claim without actual results. Link evidence to exact commits and image/schema heads. Preserve existing immutable migration history and security negative tests.

## 11. Required negative / end-to-end acceptance

1. Reserve against contract version 10; publish version 11; resolve later; Zayavka is still generated from immutable version 10.
2. Any Admin/API attempt to open global sales fails at HTTP **and PostgreSQL**, and Admin close-only capability cannot invoke fn_set_sales_open.
3. Stale link offerRevision N with active N+1 shows explicit updated amount/confirmation prior to reservation; POST /orders rechecks confirmed revision atomically with activation and inventory.
4. New static page N+1 while Commerce still has N cannot reserve at N. Failed pipeline before site cutover leaves N active. Failure after site cutover is recoverable/fail-closed with visible system hold/alert if needed.
5. Publishing OPEN or lifting a per-departure Admin pause never removes global operator stop; pipeline alone may clear its own hold after matching read-back.
6. A price change does not alter already frozen order amount, payment attempt, accepted documents, Refref hash or EIS material revision.
7. Concurrent holds / admin inventory reservations never oversell; HELD and PAYMENT_PENDING never time-release without authoritative proof.
8. Sensitive passports/EIS packet are absent from Admin API/bundle/logs; only privileged CLI can attest EIS_SUBMITTED.
9. New tour/departure/review/media can be created, validated, previewed and published solely in Admin; isListed missing/false remains unlisted; old YAML/git writer cannot change live catalog.
10. CDN delivers only processed public variants; S3 private originals remain private; direct-S3 fallback and return-to-CDN work with HTTPS, correct cache and SSG rebuild.
11. A static site visitor does not automatically call booking Commerce; midnight stale-departure rebuild uses only published release, never unapproved drafts.
12. Exact new-schema logical restore and PITR proof passes with immutable migration history, and checkout/recovery negative tests remain green.

## 12. Alternatives considered

- **Keep Sveltia + sync Commerce:** rejected; two operational writers and eventual CRM integration burden.
- **Make public site SSR or fetch price on every page view:** rejected; breaks SSG/no-user-data promise, adds per-visitor Commerce ingress and complicates SEO.
- **Activate price before SSG rebuild:** rejected; promotes an unadvertised amount and allows persistent mismatch if build fails.
- **Hard-lock all departures during every editorial publish:** rejected; routine revision-aware admission and explicit buyer confirmation suffice.
- **New PostgreSQL schema baseline or customer backfill:** rejected; discards established migrations/security proof and conflicts with empty production customer state.
- **Browser-upload directly into public S3 or full CDN for private media:** rejected; exposes unvalidated files/PII.
- **Permanent backup HTTPS media gateway:** rejected for v1; resolver switch and SSG rebuild meet accepted downtime.
- **CRM data from retained order contacts:** rejected; violates minimization and current erasure semantics.

## 13. Authoritative references and follow-up

- docs/DECISIONS.md (#1, #2, #5, #6, #7, #8, #9, #10)
- commerce/README.md and commerce/runbooks/production-launch.md
- commerce/src/catalog.ts, orders.ts, checkout.ts, legal-admission.ts, eis.ts and migrations/0001–0007
- public/admin/config.yml; lib/cms/types.ts; lib/cms/normalize.ts
- Flexperiment docs/admin-operations.md; commerce-v2 course-editorial publication reference
- GitHub Mikluha PR #24 (slice-4 protection, merged), PR #25 (legal/contract invariants, merged)
- Linear project mikluha-maklai.ru: epics and implementation tasks own ordering, blockers, owner-action gates, CI and cutover evidence. Cross-link existing ART-307, ART-308, ART-317, ART-318, ART-327 and ART-51 rather than duplicating their obligations.

**Decision approval:** the owner approved hard cut, self-written Admin, cloud.ru S3 + TurboFlare intention, PostgreSQL authority and no historical backfill in discussion; ADR is proposed pending PR review. This file is documentation only: no migration, deployment, DNS change, production data operation or sales activation is implied.
