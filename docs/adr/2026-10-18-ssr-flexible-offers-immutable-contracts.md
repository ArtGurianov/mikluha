# ADR v2.3 — SSR storefront, editable offers, immutable accepted contracts

- **Status:** Accepted by OWNER decision (2026-10-18) as architecture; **not implemented/deployed**. Runtime migrations, the SSR cutover and every sales-opening gate remain separate owner-controlled work.
- **Date:** 2026-10-18
- **Supersedes in [ADR v2.2](./2026-10-16-immutable-departures-manual-publishing.md):** §2 (offer sealed at first publication, clone-for-new-price), §5 (static publication job), §6 (comparison table), §7 items 1, 2, 8, 9, 10, 11, §8 and §9. The parts of §3 and §4 that this ADR changes are named in §5 below; the rest of §3 and §4 stays in force. ADR v2.2 stays in Git unedited apart from its supersession header.
- **Supersedes in [ADR v2.1](./2026-10-16-control-room-hard-cut.md):** the rejection of SSR (§12 "Make public site SSR"), the sealed S3 content release and build-time media resolver (§4, §8), and "MFA with tested recovery" (§7) as refined in §7 below.
- **Retains:** PostgreSQL as the single mutable authority, forward migrations from `0008+`, the isolated Admin API with separate DB roles, `bookingStatus` as the only per-departure sales field, CLI-only `GLOBAL_OPERATOR_STOP` reopen, transactional capacity and batch close, immutable orders/Zayavka/legal/payment evidence, Refref read-back as payment truth, cloud.ru S3 media and the TurboFlare go/no-go, no default YAML import, all first-sale gates.
- **Planning:** existing Linear M11/M12/M13; no new epic.

## 1. Context

OWNER decisions of 2026-10-18:
1. The public site becomes **Next.js SSR** (`next start`), not `output: "export"` and not ISR.
2. Tour programs and prices must stay **editable** by the organizer. The offer contract reserves the right to replace programme elements with equivalent ones; a quality downgrade leads to a dialogue about a refund or partial compensation. Customers are notified by e-mail (social posts only add to it). Bookings are **not** stopped or refunded because a page description or the make-up of an occurrence changed.
3. What a buyer accepted must never be rewritten retroactively.
4. A quote created at checkout guarantees its price for its validity window regardless of later price changes or an ordinary sales close.

ADR v2.2 froze every contractual field of a departure at its first publication and required a clone for any price change or correction, because a static page built from an earlier snapshot could otherwise advertise one price while Commerce charged another. Under SSR the page and checkout read the same live authority, so that reason disappears. Immutability moves **from the published departure to the accepted order**, where Mikluha already stores it (`orders.unit_price_kopecks`, `amount_kopecks`, trip dates and times, `legal_release_content`, PD consent, frozen booking conditions from ART-47).

## 2. Decision: SSR storefront reading Commerce

- `mikluha-maklai.ru` runs `next start` behind the Coolify proxy. Tour and departure pages render on request from a **read-only public projection served by Commerce** (an HTTP API on the internal network, the same pattern as Flexperiment Platform → Commerce). The site never connects to PostgreSQL and holds no Admin or operator credential.
- Public pages are dynamic and `Cache-Control: no-store`. The CDN caches **media only**, never HTML. There is no publication job, no rebuild on content change, no sealed S3 content release, no publication lock and no build that reads production data. The Docker image contains code only.
- **Draft vs publish:** "Save draft" never changes the public projection. "Publish" switches the published revision of a tour or departure in **one PostgreSQL transaction** with an expected-version check (optimistic concurrency); a stale tab or double click gets a conflict, not a silent overwrite. Each publish keeps its revision for audit. This is the Flexperiment `course-editorial` pattern; no publishing coordinator is needed.
- DECISIONS #5 still holds: the site sets no cookies, renders nothing per visitor and calls Commerce server-side for public data only. Access logs stay as they are for Nginx today.
- The client-side "past date" hint from ADR v2.2 §5 becomes unnecessary: the page renders the authoritative state. Commerce `bookable()` remains the gate.
- Media URLs are resolved at request time. The TurboFlare ↔ direct cloud.ru fallback is a runtime configuration switch deployed like any configuration change, with no content rebuild.
- Code releases follow §8. Code release and content publication are fully separate.

## 3. Decision: departures are editable offers; orders are immutable contracts

Tour templates resolve into the departure once, when the departure is created or first published (whole override, no field merge), as in ADR v2.2. After that the departure's own fields are edited directly; template edits affect only departures created later.

| Change | Departure has active or concluded orders? | Rule |
|---|---|---|
| Description, photos, SEO, reviews | any | edit and publish freely |
| Price | any | edit freely. It applies to **new quotes only**; issued quotes and existing orders keep their price |
| Start/end dates and times | none | edit freely |
| Start/end dates and times | **yes** | **field locked**. Only the separate "move or cancel" workflow (§4) changes them |
| Programme, route, accommodation, carrier, included services | none | edit freely |
| Programme, route, accommodation, carrier, included services | **yes** | allowed only as a **classified execution change** (§4) |
| `slug`/`unitRef`, tour binding, `published_at` | — | immutable after first publication (DB trigger, as Flexperiment migration `0013_product_identity_immutable.sql`) |
| A published departure | — | never physically deleted; order FKs `ON DELETE RESTRICT` |

"Active or concluded orders" means any order in `RESERVED` (unexpired), `PAYMENT_PENDING`, `HELD`, `PAID` or a later non-terminal state.

The order snapshot is the contract: the departure's resolved contractual fields are copied into the order when it is reserved, with the legal release and PD consent already stored there. **Zayavka, receipts and every later document are generated from the order snapshot, never from the current departure** (this requirement of ADR v2.2 §2 stays). A DB trigger rejects UPDATE of the snapshot columns after `RESERVED`.

No `offerRevision`, no clone-for-new-price and no separate `departure_contract_version` table are introduced. Order snapshots already prove what each buyer accepted; the editorial revision history (§2) proves what the page showed.

## 4. Execution changes for existing buyers

Editing contractual fields of a departure that has active or concluded orders is not an ordinary edit. Control Room shows the affected orders and requires OWNER to classify the change before it is saved:

- **EQUIVALENT** (within the offer's equivalent-replacement clause): saved, and every affected order receives an individual e-mail through the transactional provider. The send and delivery result are recorded per order as evidence. Social posts may add to it; they never replace it.
- **MATERIAL** (dates, a downgrade of accommodation, route or services, anything with a legal effect under No. 132-FZ art. 10 and Decree No. 551): not applied as an edit. It goes through the move/cancel workflow: notice, the buyer's consent, or termination with a refund or compensation under the reviewed runbook (ADR v2.2 §3 cancellation rules apply unchanged).

The classification, the notice and its evidence are audited. The order snapshot is never changed; the change is recorded as an event on the order.

## 5. Quote, closing and late payment

These rules refine ADR v2.2 §4 and follow the cross-merchant purchase lifecycle of Refref `docs/29` §5:

- A quote is created after the tourist data is entered (Refref vNext). It is payment-admissible until the **earliest** of: 15 minutes, the seat-hold expiry, the departure start, the end of an applied promotion, and a cancellation or emergency stop. A later price change does **not** shorten it.
- The guarantee is stated in the booking terms shown before acceptance ("the price shown is held for N minutes"), not inferred from the word "quote".
- **Ordinary per-departure close** (`bookingStatus OPEN → CLOSED`, including batch close): no new reservations or quotes. A quote already issued within its validity may still be accepted and its payment initiated; its seat is already held. This replaces the ADR v2.2 §4 sentence that a close blocks new payment initiation.
- **`GLOBAL_OPERATOR_STOP` and cancellation:** no new reservations, quotes or payment initiation. Live attempts are cancelled through Refref; seats are released only when Refref confirms the attempt can no longer settle (unchanged).
- **Late payment** is a recognized financial fact. The attempt carries Refref `latePaymentPolicy`: `HONOR` while the seat is still held and the departure is deliverable; `AUTO_REFUND` when it is not. A payment that arrives after a cancellation follows the cancellation runbook.
- **Prerequisite:** Refref refuses every reservation-backed Альфа-Банк session with `RESERVATION_TOO_SHORT` while the adapter declares no qualified session lifetime (`docs/28` §11). Mikluha's 30-minute hold (`RESERVATION_MINUTES`) does not help. Qualifying an explicit Альфа session lifetime ≤ hold − 2 minutes blocks M10.5.

## 6. Sales controls

Unchanged from ADR v2.2 §4: per departure only `bookingStatus` OPEN/CLOSED/CANCELLED plus `isListed`; OWNER switches OPEN/CLOSED in Control Room; `CANCELLED` only through the cancellation workflow; batch close in one transaction with selective batch restore; capacity changes under the departure lock without a pause. Reopening sales globally stays a `commerce_operator` CLI action (`commerce/src/bin/sales.ts`); Admin can close but never open the global switch. No `sales_activation`-style table is added: the CLI-only global open is the separate authority for the first real sale.

Opening a departure no longer requires a live static-page read-back (ADR v2.2 §4, §7 item 9). It requires the departure to be published, listed, not started, with valid capacity and contract fields, under the global switch.

## 7. Admin authentication

Admin login requires a password and a **TOTP** code (RFC 6238: SHA-1, 6 digits, 30-second step, ±1 step; Google Authenticator compatible). The last accepted step is stored and a code is never accepted twice. The seed is stored encrypted with a key from the environment. Enrolment: QR code, then confirmation with a first code. **No recovery codes:** a lost device is recovered by an operator CLI reset over SSH, audited. The implementation follows the shared operations standard in `adman-vps-infrastructure` and is the same in Mikluha, Flexperiment and Refref platform admin.

## 8. Code release

- CI runs on GitHub-hosted runners (the repository is public, so minutes are free). It builds the image for the exact `main` SHA and pushes it to GHCR.
- Coolify deploys it as a **Docker Image application pinned by digest**: `PATCH /api/v1/applications/{uuid}` sets `docker_registry_image_tag` to `sha256-…`, `POST /api/v1/deploy` deploys it, and the workflow follows the deployment to a terminal state and reads `/identity` back to compare the digest. Coolify stays the single deployment controller and history.
- The whole sequence (choose digest → PATCH → deploy → read-back) runs inside **one workflow concurrency group per application**. A digest mismatch on read-back fails the release. Git auto-deploy is disabled.
- Images are built by CI, never on the VPS.

## 9. Acceptance / negative tests

1. A published departure's description and price are edited with sales open; the next page render and new quotes show the new values; an issued quote and existing orders keep the old price; Zayavka of an older order renders its own snapshot.
2. Editing dates of a departure with an active order is rejected; the same edit succeeds with no orders.
3. A programme edit on a departure with orders requires EQUIVALENT/MATERIAL classification; EQUIVALENT sends one e-mail per affected order and records delivery evidence; MATERIAL is refused as an edit and routed to the move/cancel workflow.
4. UPDATE of `slug`/`unitRef`, tour binding, `published_at` or an order snapshot after `RESERVED` fails both through Admin API and with direct DB credentials; DELETE of a published departure fails.
5. Two concurrent publishes with the same expected version: one wins, the other gets a conflict. "Save draft" never changes the public page.
6. Price change at 14:10 against a quote issued at 14:00 for 6 500 ₽: acceptance at 14:14 creates an order for 6 500 ₽; a new quote shows the new price.
7. Ordinary close at 14:05 against a quote issued at 14:00: payment can still be initiated until the quote expires; a new reservation is refused. `GLOBAL_OPERATOR_STOP` blocks both.
8. The SSR site responds `no-store`, sets no cookies, has no DB or Admin credentials, and keeps serving after a Commerce restart with an error state rather than stale prices.
9. A release whose `/identity` digest differs from the deployed digest fails; two releases of the same app never interleave PATCH and deploy.
10. TOTP: a reused code within its step is rejected; a code outside ±1 step is rejected; CLI reset re-enrolls and is audited.
11. All ADR v2.2 §7 items not listed as superseded (3–7, 12, 13) still pass, except that item 5 now allows payment initiation for a quote issued before an ordinary close (§5).

## 10. Risks and consequences

- The site depends on Commerce at request time. If Commerce is down, pages show an error state instead of stale data. Accepted: Commerce down already means no bookings.
- The SSR runtime uses about 106 MB more RAM than the static container (measured 2026-10-18: Flexperiment Next 16 platform 117.6 MiB vs Mikluha static 11.6 MiB) on a VPS with about 4 GB free.
- Editable prices mean different buyers pay different prices for the same departure. This is lawful for a public offer to new buyers and is shown before acceptance.
- EQUIVALENT vs MATERIAL is an OWNER judgement; a wrong classification is a legal risk. The audit trail and the per-order e-mail evidence make it reviewable.

## 11. Execution map

- **ART-357:** PostgreSQL 0008+: identity triggers (§3), order snapshot immutability, date lock with active orders, editorial revisions with expected version; drop the freeze-at-first-publication barriers.
- **ART-358:** content CRUD and publish transaction; no clone-for-price.
- **ART-359:** legal/code/content compatibility under SSR; remove static-export admission and the S3 content release.
- **ART-360:** Coolify Docker Image by digest PoC (§8) and the SSR hard cut; no publishing job.
- **ART-362:** quote rules (§5) and the Альфа session-lifetime prerequisite.
- **ART-363:** Admin with TOTP (§7).
- **ART-364:** media resolver at request time.
- **ART-365/366:** editors with the §3 table and §4 classification; bookingStatus controls unchanged.
- **ART-367:** remove Sveltia, Git/YAML writers, `publish.yml` and its nightly schedule, `sync:content`/`validate:out` export steps.
- **ART-368:** SSR E2E, recovery proofs and the owner-authorized hard cut.

None of this opens sales.
