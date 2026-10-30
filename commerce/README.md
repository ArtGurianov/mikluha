# Native Commerce runtime (TOUR-60/66, 2026-10-30)

The current public process (`src/bin/serve.ts`) serves anonymous `/public/v1/catalog`, health,
identity and readiness. Retired `/book`, `/orders`, `/return`, `/arrive` and `/documents` paths
return 410 for every method. It creates no Refref client and starts no legacy payment worker.
Refref credentials are no longer required or read. Sales remain CLOSED pending native checkout
qualification. Settings and legal release remain code-owned read-only inputs pending TOUR-59;
Git/YAML tours/departures do not ship in the image. Native purchase/database/Admin contracts remain.

Build context is the repository root: `docker build -f commerce/Dockerfile --build-arg SOURCE_COMMIT=<40-hex> .`.
`pnpm build` clears old output before compiling. The runtime includes `src/` output only;
`test/retired` and `test-fixtures/catalog` preserve historical evidence outside the image.

Current env: `DATABASE_URL`, `COMMERCE_ENVIRONMENT`, `CONTENT_DIR`, `COMMERCE_ORIGIN`, `SITE_ORIGIN`,
Notisend settings and the immutable build identity. Production legal/schema admission still applies.
No credentials are added or rotated by this source change. New DB backup/restore before real data
and live setup remain TOUR-65/67/VPS-15. The source PR makes no deployment or sales claim.

## Historical implementation and qualification record

The following pre-2026-10-30 material records previous slices. References to Refref checkout,
Sveltia, static-site releases, Git/YAML catalogs and their runtime credentials are superseded above.
Do not use those historical instructions to restore a retired system.

# mikluha-commerce

Target design for a separate merchant-native Refref v10 transition, with mandatory deposits
and later balance payments: [Mikluha Commerce vNext](../docs/refref-v10/README.md).
It is a documentation draft; the source/runtime and historical v9 status below remain distinct.

For the approved Refref v9 product rules (ADR-140 revision 7: one Commission per
booking) and the still-unimplemented purchase-manifest contract, see [TOUR contract status](../docs/refref-v9-contract-status.md).
The current full-only Alfa qualification below does not qualify merchant-owned
partial refunds or v9 reward cancellation.

Mikluha's booking and payment service (`docs/DECISIONS.md` #9, Linear ART-47). The public site stays
static; everything that sells a trip lives here, with its own Postgres.

**Done:**
- slice 1: orders and seats, the personal data an order needs and its erasure, the booking switch,
  health, readiness and identity;
- slice 2: the Refref checkout. Handoff, referral resolution, the final price, one frozen attempt,
  the PROVIDER payment session, and read-back-driven payment and fulfilment.
- slice 3b: public legal pages, direct site-to-commerce booking links, real-contract production
  gates, and separate versioned personal-data consent evidence.
- slice 3c: an atomic Postgres confirmation-email outbox delivered asynchronously through
  Notisend, bounded proxy-aware booking throttling, and site-matched customer pages with access
  to the exact offer and Заявка frozen on the order.
- slice 3d: manual ЕИС filing state, operator-only submission evidence, fail-closed stale-filing
  detection, and the first-sale filing checklist.
- slice 4 application controls: immutable site/commerce build identities, live legal-release
  admission at startup/readiness/reservation/payment, merchant-order recovery after an ambiguous
  attempt create, aggregate PD-free monitor signals, and the owner-run production launch gate.
- migration 0008 (ADR v2.3 §2–§3, ART-357): tours and departures in PostgreSQL with editorial
  drafts, immutable published revisions and expected-version publish; immutable published identity
  (slug/unitRef, tour binding, `published_at`) and no physical delete; the date lock while a
  departure has active or concluded orders; and every new order's `contract_snapshot` (see
  "Editable offers, immutable orders"). `bookingStatus`/capacity transitions (ART-366) and
  checkout documents and quotes now consume it through ART-362 below.
- migration 0009 (ADR v2.3 §2–§4, ART-358): content CRUD for tours, departures, reports, reviews,
  organizers and legal drafts through audited Admin commands (`src/editorial.ts`); the tour
  template resolved into a departure once; graph validation at publish; the fail-closed public
  projection (`src/public-content.ts`); and classified execution changes on sold departures with
  one notice per affected order (`src/execution-notice.ts`). See "Content CRUD and execution
  changes".
- migration 0010 (ART-358 review correction): stable execution-change identity and MATERIAL replay;
  organizer visibility closes the whole departure and propagates to its reports. Migrations 0008
  and 0009 retain their original bytes and checksums.

- ART-382: the Refref vNext arrival endpoint `/arrive` with the 30-day browser context and the
  after-response claim (see "Refref vNext arrival"). Not yet used by checkout (ART-383).
- TOUR-81 (interim): new referral ingress and promo codes are off. `/arrive` is inert and the
  service builds no Arrivals or vNext client, whatever `REFREF_VNEXT_API_BASE` says; the order form
  shows the promo code and Apply disabled. Checkout itself is still the legacy Refref RC handoff
  until TOUR-76/77/78 (see "Native entry").
- migration 0011 and the isolated Admin API (ADR v2.3 §7, ART-363): password + TOTP at every
  login, sessions, OWNER-only publishing and classification bound to the signed-in session, the
  audited SSH reset, `admin_app`/`admin_publisher`/`admin_operator` capabilities, and the static Control Room in
  [`../control-room`](../control-room/README.md). See "Admin API" below. Undeployed.

- migration 0012 (ART-362): live DB-backed reservations tied to the accepted published revision,
  snapshot-only documents/receipt names, immutable 15-minute quotes and merchant-held seats.
  Audited operator cancellation cannot complete over unresolved orders. See "Checkout contracts
  and quotes" below. Undeployed.

**Next:**
- qualify the selected documented-expense refund workflow separately; obtain real commercial
  facts, signed processing instruction and remaining legal/provider evidence. Refref host
  integration #48/#49 is merged; schema-6 restore proofs and timers have passed, but migrations
  0007–0017 need owner-only application and fresh schema-17 logical and PITR recovery evidence
  before future admission. Mikluha commerce is undeployed; monitor admission, sales and payments remain closed.

## Generic legal pack and individual application

All tours use the same `content/legal/` pack. The offer's version/hash, tourist PD consent's
version/hash, and Refref processing instruction evidence are three separate artifacts; neither
PD artifact changes Refref's commercial `legalReleaseHash`.

`tour.contract` supplies shared product defaults. An optional `departure.contract.product`
**replaces all product conditions** (route/program/inclusions/exclusions/insurance/risks), never
merges them. A supplied null/incomplete override cannot fall back to a different/demo trip.
Departure conditions supply valid exact `departureTime`/`returnTime`, accommodation nights and
meal plan, carrier and explicitly included/optional services. The frozen application identifies
the departure and shows calendar days separately from accommodation nights, in the site timezone.
These same exact times become Refref's service instants.
Times and timezone are frozen with the reserved dates/price and cannot be updated on that order.
A later catalog cannot replace them; historical rows without them refuse resolution/new payment
rather than guess. Correcting the frozen schedule requires a separately reviewed replacement
contract workflow, not a direct schedule update. Already frozen payment read-back is unaffected.

`altai-1` records only owner-supplied dates/times, 26,500 RUB/person and nominal capacity 40. It is
CLOSED and unlisted, with unresolved accommodation/address/program/inclusion facts left blank;
capacity must still be reconciled with offline reservations before opening. It is not a real offer
or a substitute for supplier/registry evidence.

The offer now selects `refundPolicy: DOCUMENTED_EXPENSES`: voluntary full refund with notice at
least five calendar days before departure; later only documented actual attributable expenses,
never fixed percentage penalties or automatic forfeiture for no-show. Commerce currently qualifies
only `FULL_ONLY`. For `DOCUMENTED_EXPENSES`, production startup, new reservations and payment
initiation fail closed as `REFUND_WORKFLOW_UNQUALIFIED`, independently of launchReady/sales switch.
Existing payment read-back/fulfilment/cancellation remain available; no partial-refund engine is
implemented here. Removing the metadata also refuses catalog load. Do not relabel the expense
policy `FULL_ONLY` to bypass qualification.

`commerce/legal/pd-processing-instruction-refref-v1.md` is a generic signing form. Migration 0007
stores its exact template hash as DRAFT with NULL signature evidence and SELECT-only access for
runtime/operator. It does not claim the instruction is signed. The owner verifies completed
requisites and signatures, stores the signed bytes privately in Russia and records the actual
signed-file digest/dates/reference in a separately authorized step (launch runbook §3).

## Rules the code keeps

| | |
|---|---|
| price | the full departure price for every seat, frozen on the order; online checkout never collects a partial advance |
| what is sold | an OPEN, listed departure with a `price` and a `capacity` that has not started; demo departures only in STAGING |
| seats | counted here, never in the CMS; checked under a per-departure lock; RESERVED for 30 min, PAYMENT_PENDING and HELD never freed by time |
| personal data | the customer (Заказчик) is tourist №1, plus a phone and an email; a customer who does not travel is not booked online. Every tourist: what ЕИС «Электронная путёвка» requires (ПП №417): full name, date of birth, citizenship, and an identity document (type, series where it has one, number). Nothing more: no issue date, issuer, address or scans. Adults only. Nothing personal in logs |
| PD consent | a separate published `soglasie-pd` artifact, not the offer. The booking form carries its version reference and hash and requires its own checkbox. Commerce validates them, stores the authoritative text, reference, hash and acceptance time, and verifies the evidence again before payment. It is never included in Refref's `legalReleaseHash` |
| transactional email (3c) | one Postgres outbox row is inserted with FULFILLED in the same transaction; an async worker (every 10 s) sends through Notisend (`POST /v1/email/messages`) and stores the Notisend message `id`. Notisend has no idempotency key, so a send is repeated only when the message provably was not queued (HTTP 429 after the provider's delay, or a connection that never opened), at most 10 attempts. Any outcome where it may have been queued (timeout, reset, 408, 5xx, unreadable success) and an expired send lease become operator attention without another send; so does a refusal (4xx) or a `skipped`/bounced recipient. The stable outbox key travels as the `X-Mikluha-Outbox-Key` header so an operator can match the message in the Notisend log. Contract/order mail has no unsubscribe mechanism; marketing is a separate class |
| booking rate limit (3c) | trust only exactly one valid `X-Forwarded-For` IP from the single Coolify/Traefik hop; missing, malformed or multiple values share one conservative untrusted-ingress bucket. The in-memory store has TTL eviction and a hard size bound. A body-size limit and order-scoped controls remain separate protections. SmartCaptcha is reserved for observed abuse, not launch |
| ЕИС filing (3d) | the first proven paid state atomically creates `EIS_PENDING`. Only an explicit `commerce_operator` action after manual submission in the ЕИС personal account records `EIS_SUBMITTED` and its actual electronic-voucher number. One normalized number is lifetime-owned by one order, including historical numbers after corrections, and concurrent cross-order claims fail closed. Submission must name the material revision printed with the reviewed filing packet; an intervening change is refused as `EIS_PACKET_STALE`. A later contract/tourist correction or refund becomes `EIS_NEEDS_UPDATE`; commerce never claims it filed anything and has no ЕИС API integration |
| contract | the offer (`content/legal/oferta.yml`) plus the order's **Заявка на бронирование** (`src/zayavka.ts`), built only from the verified order `contract_snapshot`, its frozen facts and tourists. A departure without complete contract data is not sold. The authoritative offer text/ref/hash are frozen on reservation and re-hashed before payment. The Заявка is rendered when the price is resolved, shown before paying exactly as stored, and accepted by paying; `/pay` carries its hash, and a different one is refused. Both frozen documents remain available on the cookie-protected order page and through the high-entropy bearer link in the confirmation email; only the token hash remains in `orders`, and the outbox drops its plaintext token when Notisend accepts the mail. The bearer token/path must be redacted or excluded from live Traefik/Coolify access logs. The database forbids replacing the Заявка even before payment; retention may only erase its content, keeping the digest. Erased 3 years after the contract ended (24 hours after an unpaid order ends); its hash stays |
| erasure | unpaid (EXPIRED, CANCELLED): everything, the Заявка included, within 24 h of ending; no contract was concluded. A paid trip (PAID, FULFILLED, REFUNDED): the contact and tourist rows 90 days after it ends; the Заявка, which is the contract, **3 years after the contract ended** (ПП РФ №748): the trip's end for FULFILLED, the refund (`closed_at`) for REFUNDED, never for a PAID order, whose contract is still open. Nothing under `legal_hold` or while money is unresolved |
| booking switch | closed on a new database. Only an operator login (`commerce_operator`) can change it, through `fn_set_sales_open`, which records who, why and the database login. The service can read it, never change it. A sale reads it under a lock in its own transaction |

## Checkout (refref docs/28)

```
GET  /book?departure=<slug>   form: contact, passengers, separate PD consent, terms (slice 3c restyles it)
POST /orders                  reserve → state cookie → Refref attribution handoff
GET  /return?rt=&state=       state checked against this browser's cookie → referral resolution
GET  /orders/<ref>            read back from Refref first; the final price to accept, or the outcome
POST /orders/<ref>/pay        freeze the snapshot → the one attempt → payment session → the bank
```

| | |
|---|---|
| contract hash | `legalReleaseRef` is the offer version; `legalReleaseHash` is `sha256` over the offer's hash and the Заявка's (`contractHash`) |
| what is paid | one FULL / ORCHESTRATED / PROVIDER obligation: the full price minus any referral discount. One fiscal item of quantity 1 equal to the payment, USN_INCOME, FULL_PREPAYMENT, SERVICE, no VAT. This is the Alfa path that was qualified, and nothing else is built (`src/snapshot.ts`). The digest remains computed independently; historical Refref vectors validate its JCS implementation |
| Snapshot V2 purpose | New attempts use `refref.shared-checkout-snapshot/2` (Refref migration `000024`) with merchant-owned `paymentPurpose = "Оплата туристского продукта по заявке <orderRef>"`, derived only from an immutable server-generated order reference. It is NOT the fiscal item name, receipt email or tourist data. The purpose is frozen under the snapshot hash and replayed byte-identically. Existing V1 evidence is not rewritten. The fake Refref refuses new V1 attempts. Refref's CI runs the real consumer (see below); live production conformance is still the separate ART-275 acceptance |
| refund qualification | only the full PROVIDER refund is technically qualified. The published documented-expense policy is not: launch and new payments are blocked until its separate end-to-end workflow qualification; this PR implements no partial refunds |
| PAID | only from Refref's read-back: the obligation SATISFIED by a SUCCEEDED payment of exactly the payable amount. The customer's return from the bank decides nothing |
| no second payment | one attempt per order, created with the fixed key `mk-attempt:<ref>`; an unanswered request is repeated identically. Sessions are only re-requested on that attempt: Refref replays a live payment and starts a new one only after a definitive failure |
| ambiguous create recovery | after an unanswered create, read the Refref merchant-order projection and accept exactly one attempt whose `snapshotHash` and `referralResolutionId` match the frozen order. A foreign/mismatched projection is HELD; no payment session is started |
| seats of a payment | freed only when Refref confirms the attempt can't settle. Either the cancel answers CANCELLED (tried after 60 minutes OUTSTANDING), or the attempt reads back CANCELLED or EXPIRED without money. Anything inconsistent is HELD, with seats kept |
| fulfilment | PAID → `fulfillment-ack` DELIVERED (key `mk-fulfil:<ref>`) → FULFILLED |
| personal data to Refref | the receipt email in the payment session, which PROVIDER fiscalization requires. Nothing else |
| the switch | closed: no new payment session. Reading back, fulfilment and cancellation go on |

## Native entry: NATIVE_NO_REFERRAL (TOUR-81, interim)

TOUR-81 turns off new referral ingress and promo codes (`docs/refref-v10/05` M4). It does **not**
make checkout native: until TOUR-76/77/78 switch it, `POST /orders` still hands every new order to
the legacy Refref RC attribution handoff, and Refref may still resolve a referral discount there
(`/return`, the order page). The full `NATIVE_NO_REFERRAL` requirement for new purchases is not yet
accepted. Do not deploy this state on its own: it drops arrivals while checkout is still Refref's.

What is off now is the code, not the configuration:

| | |
|---|---|
| `/arrive` | `302` to the clean site page (`to` checked as below, `arrival` dropped). The proof is never read, kept, claimed or logged (only `arrival_ignored` without it); no context cookie, nothing after the response. Old Refref links therefore never block a purchase |
| vNext | `src/bin/serve.ts` builds no `Arrivals` and no vNext client. `REFREF_VNEXT_API_BASE` is ignored and the `listening` event says so (`vnextApiBaseIgnored`) |
| promo code | `/book` shows the promo code and Apply disabled, with the reason. The input has no `name`, Apply is a disabled `type="button"` and the CSP allows no script. No discount, partner credit or later application is promised |
| order fields | `POST /orders` reads an explicit whitelist. Promo, Apply, `ref`, utm, autofill or price-like fields, in the body or the query, are never read |
| legacy | Refref RC read-back, fulfilment and cancellation of existing orders continue in their own scope |

`test/native-ingress.test.ts` proves it over HTTP and against the real entrypoint with
`REFREF_VNEXT_API_BASE` pointing at a live claim server, across a restart, while the legacy
read-back is counted separately. It does not cover a native purchase, which does not exist yet.
The section below is the deferred prior contract.

## Refref vNext arrival (ART-382, Refref ADR-139 `docs/29` §2, §4, §6, §8)

**Not wired under NATIVE_NO_REFERRAL** (see above). `src/arrival.ts` and its tests keep this prior
contract for the deferred referral profile (TOUR-70); its cookie or proof never becomes a v10
touch or BOUND.

TOUR conformance profile. Refref's referral link redirects once, straight to this origin; the public
site is static and cannot capture anything server-side.

```
GET  /arrive?arrival=<proof>&to=<site path>   context cookie → 302 to the site page, no Refref wait
```

| | |
|---|---|
| browser context | `__Host-mk_ctx`: 32 random bytes, host-only, Secure, HttpOnly, SameSite=Lax, `Max-Age` 30 days (the Mikluha attribution window), re-set by every arrival. One context per browser: a later arrival reuses it. `/book` and `POST /orders` give one to a buyer without a referral. Carries no buyer identity |
| proof | `src/arrival.ts`: kept in process memory only, tied to the context, at most 30 minutes after capture, erased by an independent timer even without later requests (also cleared on eviction); never in Postgres, a log, a Location or a page. A restart loses it (accepted, `docs/29` §6). No durable queue |
| exchange | `claimArrival` is launched after the response through a tracked hook (drained on shutdown), ≤ 500 ms of wall clock including queue admission. Per process: at most 16 active HTTP claims and 64 queued claims (shared with Buy); overflow/queue timeout keeps proof pending, logs `arrival_claim_unknown` with `OVERLOADED`/`QUEUE_TIMEOUT` and yields `TIMEOUT`, allowing a later request to retry. Repeated requests of a context coalesce; a newly captured proof during an attempt gets one tracked follow-up. Every later request of the context retries an unconfirmed claim the same way (single-flight, every 2 s at most; a new arrival is never throttled). The repeat is byte-identical, so a committed claim lost in transit reads back as a replay |
| before Buy | `Arrivals.beforeBuy` spends ≤ 1,500 ms total using a monotonic deadline, including shared in-flight work and queue waiting, and returns the `deliveryDegraded` value to freeze: `TIMEOUT` (still unconfirmed), `FAILED` (definitive proof refusal or configuration rejection: HTTP 401/403 or `BROWSER_CONTEXT_IDLE_POLICY_REQUIRED`; raw proof erased, no retry for that proof, operator event `arrival_claim_configuration_failed` with status/code only), `EXPIRED` (30 minutes passed). Checkout wires it into the vNext resolution in ART-383; the RC.2 handoff is unchanged until then |
| refused context | `CONTEXT_CLOSED`/`CONTEXT_SCOPE_MISMATCH`: the next request gets a new context and the unconfirmed proof follows the browser (guest storefront, no account boundary); the old ID is never presented again while this process remembers it |
| redirect | `to` must be a plain absolute path of `SITE_ORIGIN`; anything else (another host, `//`, backslash, control characters, > 512 characters) goes to the home page. Any `arrival` parameter is dropped |
| to Refref | the proof, the context ID and `COMMERCE_ORIGIN`. Never a tourist's name, document, date of birth, phone or email |
| Buy | `/book` posts to `POST /orders` on this origin, a top-level same-origin form, so the context cookie arrives. Never call commerce by cross-origin `fetch` without credentials |
| configuration | `REFREF_VNEXT_API_BASE` (production: `https://api.refref.ru/v1-vnext`), optional until Refref's staged cutover; unset, arrivals still land and checkout declares the proof undelivered. The Refref Business needs `/arrive` as a verified destination of this origin and an owner `browser_context_idle_policy` row for it |

**The Refref Business needs:**
- an API key with `integrations:checkout` and `integrations:fulfillment`;
- `COMMERCE_ORIGIN` verified, with destination path prefixes `/return` and `/orders` (Refref's
  `provision-merchant` refuses a prefix that ends in `/`);
- an Offer per tour slug (`offerRef`) wherever a campaign should apply. The departure is the
  `unitRef`.

**Refref runs this consumer in its CI (ART-275).** Refref pins `src/checkout.ts`, `refref.ts`,
`snapshot.ts`, `contract-snapshot.ts`, `zayavka.ts`, `orders.ts`, `catalog.ts`, `migrate.ts`, `config.ts` and `migrations/`
byte for byte at a reviewed commit (`refref/scripts/fixtures/mikluha`). Its
`contract:mikluha-consumer-served` suite runs them against Refref's served runtime on Альфа PROVIDER,
with the merchant provisioned as above. A change to these files reaches Refref only when Refref moves
that pin. This detects a break only after the pin is advanced; it does not monitor Mikluha HEAD.
Before releasing a changed consumer, update Refref’s pin to the exact release candidate commit and
require `node scripts/verify-mikluha-pin.mjs --candidate=<release-source-sha>` in Refref and that
candidate’s served conformance result. An older green pin does not qualify a new release. The suite
uses a modelled gateway and is not live acceptance.

## Editable offers, immutable orders (migration 0008)

| | |
|---|---|
| draft and publish | `fn_save_*_draft(id, expectedRevision, document, by)` never changes the public row. `fn_publish_*(id, expectedDraftRevision, expectedPublishedVersion, by)` copies the draft into `tour`/`departure` in one transaction under the row lock and appends an immutable `*_revision` (document, sha256, who, which login). A stale tab or a double click gets `DRAFT_REVISION_CONFLICT`/`PUBLISHED_VERSION_CONFLICT` |
| identity | after the first publication, `slug` (offerRef/unitRef), a departure's tour and `published_at` never change and the row is never deleted, for every login including the owner; revisions are never updated or deleted; TRUNCATE is refused. Orders reference `departure` `ON DELETE RESTRICT` |
| date lock | `starts_on`, `ends_on`, `departure_time`, `return_time`, `timezone` cannot change while an order is RESERVED (unexpired), PAYMENT_PENDING, HELD, PAID or FULFILLED, matched by `departure_id` or, for orders made from `content/`, by slug. The check takes the same `departure:<slug>` advisory lock as `reserve()`. Only the move/cancel workflow (ADR v2.3 §4, its own migration) will change them |
| price, programme, description | edited and published freely; they reach new orders only |
| `contract_snapshot` | written by `reserve()` (`src/contract-snapshot.ts`, schema `mikluha.order-contract/1`, `sha256:` of its RFC 8785 form): price, programme, route, accommodation with registry facts, carrier, included/excluded services, schedule and meeting points. The database checks its shape and that it agrees with the order's slug, dates, times, timezone and price, requires it on every new order, and refuses any later change, NULL or backfill; an order never changes `departure_id`. Orders from before 0008 keep NULL |
| roles | `commerce_app` reads `tour`/`departure` only. `admin_app` (the isolated Admin API, ADR v2.1 §7) writes only through the editorial functions, which refuse any login that belongs to `commerce_app` (since 0009 it creates through them too, with no INSERT grant); it has no access to orders, payments, the switch or ЕИС. No role can change `booking_status`, `capacity` or `is_listed` yet (ART-366): departures stay CLOSED and unlisted |

`reserve()` reads the published public PostgreSQL projection under the departure row/advisory
locks, stores `departure_id` plus `accepted_departure_version` (an immutable revision FK) and builds
the snapshot from that row. YAML cannot admit a missing, hidden or closed database departure.
Supplier-name retention and the infrastructure role checker’s `admin_app` support remain
owner-installation prerequisites.

## Checkout contracts and quotes (migration 0013, ART-362)

- `/book` and new reservations read published PostgreSQL offers. Legal release/PD consent and
  refund qualification retain their existing separate gates. No content import or opening is
  performed by this migration; an empty/unlisted DB catalogue refuses sales.
- Resolution issues one immutable quote. Its exclusive deadline is the minimum of 15 minutes,
  remaining hold, frozen departure minus 24 hours and Refref resolution expiry. This slice applies
  no merchant promotions; adding one must also cap the deadline by its end. Cancellation or global
  stop reject initiation under the same locks; ordinary CLOSED still permits an issued quote.
- The stored application states the price guarantee and deadline. Programme, supplier, title,
  schedule and receipt names come from the verified order snapshot only. A repeated/concurrent
  return reuses the exact quote/document and never extends its expiry. Historical missing/invalid
  snapshots fail closed; they are not reconstructed from today's catalogue.
- Expiry only releases RESERVED orders with no frozen snapshot, attempt id or payment-start marker.
  An active read-only resolution has a durable token; expiry revokes it before releasing an overdue
  unpaid hold, so a late callback cannot apply. PAYMENT_PENDING/HELD seats remain occupied past 30
  and 60 minutes. The latter is only a request to Refref to cancel, never permission to free seats.
- An operator may call `fn_request_departure_cancellation(slug, actor, reason)` using the separate
  commerce_operator login. This closes admission and marks a durable cancellation request. The
  reconciler requests Refref cancellation immediately for open attempts, continuing read-back and
  fulfilment. `fn_complete_departure_cancellation(slug, actor, reason)` refuses unresolved, HELD,
  paid or fulfilled orders (and live reservations); paid obligations require the separate refund
  workflow. Both commands are audited in `departure_cancellation_event`. A request cannot be reset
  or reopened by ordinary editorial publication.
- Global stop still permits reconciliation and fulfilment. Attempt bodies keep Snapshot V2 and
  carry neither `inventoryReservation` nor `latePaymentPolicy`; no Alfa session lifetime is needed
  to qualify this merchant-held model.

Migration 0014 records attempt-dispatch evidence separately from the frozen payment snapshot.
Only a new reservation writer supplies `NOT_STARTED`; historical orders default to `UNKNOWN`.
Before sending any `createAttempt`, Commerce commits `STARTED`, then repeats admission under a
bounded shared stop barrier. A proven first dispatch does not require merchant-order GET; previously
started/unknown work does. A 404 is not proof that an earlier POST cannot still commit. Exact-key
POST retries require current admission. A proven unstarted cancellation can end locally;
STARTED/UNKNOWN retains its seat until safe remote confirmation or manual resolution. A crash
between arming and sending is deliberately uncertain. HELD/CANCELLED logs retain their reasons,
and RESOLVED events retain sanitized attribution source. Hold/cancel technical logs are emitted only after a successful committed compare-and-set; `order_event` remains authoritative.

Migration 0015 separates remote operations from ordinary departure locking. Resolve, legal HTTP
and Refref GETs retain no transaction/client during I/O. Resolution uses an order-scoped token,
checked again under short locks when applying its result; expiry can atomically revoke this
read-only token only on an overdue RESERVED order without payment evidence. Mutating Refref calls
retain only the global share lock, shared departure-initiation barrier and per-order advisory key;
reservation and editorial publication do not take that barrier. Only cancellation requires its
exclusive side. The running service splits its original ten-connection budget into normal (8)
and initiation (2) pools with the same login, so slow writes cannot consume all normal connections.
The initiation pool waits at most 3000 ms for a connection, returning PAYMENT_TEMPORARILY_BUSY for a safe retry on the same order. All Refref HTTP calls have a 20-second absolute deadline including the response body (in addition to the 15-second inactivity timeout). A timeout remains UNKNOWN and uses the existing fixed-key recovery; it never frees payment seats.
Duplicate order requests share bounded work. No payment/uncertain operation is released on a TTL.

Migration 0016 adds `resolution_started_at`. Maintenance revokes a resolution token at two minutes only on RESERVED without frozen snapshot, attempt or payment evidence. Applying a response also checks the lease and operation identity. Pre-upgrade tokens without a start are revoked on the next maintenance pass. Identical handoff retries are permitted by Refref docs/28 §5 (201 first call, 200 identical replay, 409 different fingerprint); frozen lines and the same handoff token produce the same request. An invalid/expired handoff is not retried by maintenance: the customer follows the existing handoff again. The public order/form and refusal pages link `/#contacts` after cutoff; no new online pay action remains.

The hold is up to 30 minutes, capped at the T−24h cutoff, even if its quote expires at minute 15. The protected rebooking
link supplies a replacement reference only after verifying the old order's browser cookie. Reserve
then atomically cancels that expired, unstarted order and creates the replacement, links it with an
immutable unique `replaces_order_id`, or rolls back on any refusal. Other buyers cannot abandon
that hold. Syntax, consent, contact and passenger normalization are checked before any DB checkout;
age/capacity/date admission stays under short authoritative locks. `/book` and reserve share one
published-offer adapter and use an exclusive cutoff exactly 24 elapsed hours before local departure.

Historical RESERVED applications with no `quote_issued_at` are refused as `QUOTE_REQUIRES_REBOOK`.
Their document and price are preserved; no resolution is refreshed underneath an old application.
The protected order page shows a new-booking link for such orders and for an expired quote, retaining
the stored documents and hiding the payment action.

Historical PAYMENT_PENDING is separate: the verified frozen snapshot, original hold, resolution
expiry and frozen service start minus 24 hours define its admitted payment window. Matching attempts can be
recovered/retried and identical frozen dispatch can continue within that window, without inventing
quote timestamps or re-rendering the contract. Expired legacy initiation returns RESERVATION_EXPIRED;
read-back/fulfilment continue. A schema-11 upgrade test covers both pending cases and refused
RESERVED repricing.

Source/isolated tests do not establish provider conformance, production migration/restore/PITR,
D8, financial activation or the owner-authorized SSR cutover. See
[design and validation scope](../docs/plans/2026-10-23-art-362-checkout-design.md).

## Purchases, revisions and the native profile (migration 0017, TOUR-76)

A purchase is one economic purchase with a stable `purchase_ref` (`mp-` + 20 hex). Its
`lifecycle_profile` and `payment_owner` are assigned by the database when it is created —
`NATIVE_NO_REFERRAL` and `MIKLUHA_NATIVE`, constants inside `fn_open_native_purchase`, not
arguments — and cannot be changed afterwards. There is no BOUND, partner, campaign or attribution
column. Accepted terms are append-only `purchase_revision` rows: document order, departure revision,
seats, price, accepted offer/consent/contract digests, `accepted_at`/`effective_at`, participant
refs and a hash over all of them chained to the predecessor. The accepted bytes stay in the document
order (`orders`/`order_document`); `purchase_revision_participant` links a participant to its
`order_passenger` row without personal data, and retention can erase that row while the link stays.

- `fn_open_native_purchase(order_id)` (commerce_app) accepts only an order created in the same
  transaction — `orders.created_xact_id`/`created_xact_at`, stamped by a trigger on INSERT and
  immutable, not a row version that any UPDATE renews — with no state, resolution, quote,
  attribution, document, frozen snapshot, attempt or payment. Orders from before 0017 have no
  provenance, so an existing order can't be adopted by the service, a worker retry or a migration.
- `trg_purchase_order_guard` refuses, unconditionally, Refref resolution and attribution columns
  (`NATIVE_PURCHASE_NO_REFERRAL`), Refref checkout/payment columns (`NATIVE_PURCHASE_PAYMENT_OWNER`)
  and changes of the accepted terms — identity, departure, seats, price, documents and their stored
  bytes (`legal_release_content`, `pd_consent_content`), consent, and `closed_at`/`pd_erased_at`
  once recorded (`NATIVE_PURCHASE_TERMS_IMMUTABLE`) — on a purchase document order. `onReturn` and
  `pay` refuse such an order before any Refref call. Browser ownership (`state_hash`) and expiry are
  unaffected.
- Its tourist rows cannot be added, edited or moved (a changed tourist is a new revision). They can
  only be deleted by qualified retention, as `maintain()` does it: `pd_erased_at` marked first and
  `fn_purchase_pd_retention_due` true — no legal hold, and 24 h since the database itself recorded the
  unpaid closure (`closed_recorded_at`, stamped once; a backdated `closed_at` does not count) or 90 days
  after a settled trip. Otherwise `NATIVE_PURCHASE_PD_RETENTION_ONLY`, also for `TRUNCATE order_passenger`.
  `maintain()` selects through the same function, so an early order is skipped, not a failed batch.
- At commit every purchase is whole (`PURCHASE_INCOMPLETE` otherwise): revision 1 exists, revisions
  are contiguous, `current_revision` is the last one and every revision has all participant links.
- `participant_ref` identifies a participant within the purchase. A later revision carries it only
  when exactly one tourist of the predecessor and exactly one of the new document order have the
  same identity document and date of birth; a replaced, added or returning tourist gets a new ref.
  The position in the list proves nothing, and the insert trigger refuses forged continuity
  (`PURCHASE_PARTICIPANT_CONTINUITY`).
- A protected replacement of the purchase's current document order appends a `QUOTE_REPLACEMENT`
  revision under the same `purchase_ref`. Replacement never crosses profiles: a deferred constraint
  trigger refuses a legacy order that replaces a purchase order (`NATIVE_PURCHASE_CONTINUATION_REQUIRED`).
- An order without a purchase has `provenance = 'UNRESOLVED'` and NULL profile in
  `order_purchase_profile`; it is never read as `NATIVE_NO_REFERRAL`. Nothing is backfilled.
- `fn_departure_taken_seats(slug, now)` is the shared capacity count (reserve now; the ART-366 /
  TOUR-65 capacity editor and TOUR-79 transfers consume it). Call it under the departure transaction
  lock (`fn_lock_checkout_departure`, or editorial row then advisory lock) and reread after locking.
  A purchase document order counts its accepted revision's seats.
- `purchase_current` is the current projection (no personal data); `src/purchases.ts` reads it.

**Trust boundary.** UPDATE, DELETE and TRUNCATE of purchase history and these guards are refused
for every login's DML, the owner's included. DDL that drops or disables triggers, or a superuser's
`session_replication_role`, is outside that guarantee: such changes reach production only as
reviewed, append-only, attested migrations ("Immutable migration history" below) run by the
trusted owner. Tests reset order tables with `resetOrders` in a disposable database only.

`reserveNativePurchase` is not wired to the public form. Switching new sales to the native profile
is the separately authorized cutover after native payment operations (TOUR-77) exist; until then
the public form keeps creating orders outside any purchase. Payment operations, money allocation,
amendments and transfers are TOUR-77/78/79. See
[design](../docs/plans/2026-10-29-tour-76-purchase-identity-design.md).

## Content CRUD and execution changes (migrations 0009–0010)

Nothing is imported from `content/`: a new database holds no content, and every tour, departure,
report, review, organizer and legal draft is created in Control Room through the Admin API.

| | |
|---|---|
| commands | `fn_create_tour`/`_departure`/`_content_item`, `fn_save_*_draft`, `fn_publish_tour`, `fn_publish_departure_change`, `fn_publish_content_item` (SECURITY DEFINER, `admin_app` only); `src/editorial.ts` calls them and maps refusals to `EditorialError` (`conflict` for `DRAFT_REVISION_CONFLICT`/`PUBLISHED_VERSION_CONFLICT`/`EXECUTION_CHANGE_CONFLICT`) |
| template | a new departure starts CLOSED and unlisted with draft revision 1 holding its tour's published contract template, copied whole. If the tour had none, the first publication copies it and advances the draft. `template_tour_version` names the tour revision and never changes; later tour edits reach only departures created later. A departure's own `contract.tour` replaces the template whole |
| graph | publish refuses a departure of an unpublished tour, an unpublished organizer, a report whose tour or departure is unpublished or whose departure belongs to another tour, a review of an unpublished tour (`RELATION_NOT_PUBLISHED`/`RELATION_MISMATCH`). An OPEN departure cannot lose its price or complete contract (`DEPARTURE_OPEN_REQUIRES_COMPLETE_OFFER`); a CLOSED one may publish an incomplete contract, which `contract_complete` keeps from being sold |
| listing | only an explicit `isListed: true` lists a tour, report, review or organizer (a tour document without the key is unlisted). The service reads pages through the `public_*` views only: published, listed, and everything the item hangs on published and listed too. A published but unlisted organizer may be linked editorially, but hides the **whole departure** and any reports tied to it; republishing that organizer listed restores visibility without republishing the departure. `src/public-content.ts` returns a listed departure in the checkout's `Departure` shape with its `publishedVersion`, so the next render and the next quote see the latest publish |
| execution change | a contract change (programme, route, accommodation, carrier, services) of a departure with active or concluded orders (`fn_departure_affected_orders`, as the date lock counts them) needs OWNER's classification and notice text. `EQUIVALENT`: published, one `execution_change_notice` per affected order (unique per change and order), an `EXECUTION_CHANGE_EQUIVALENT` order event. `MATERIAL`: recorded as `ROUTED_TO_MOVE_CANCEL` with an order event and **not** published; the move/cancel workflow is separate. A classification where none is needed is refused. Snapshots never change |
| notices | sent by the service's mail worker (`processExecutionNotices`, after the confirmation outbox) under the confirmation outbox's rules: retried only when provably not queued, otherwise operator attention, never twice. `ACCEPTED` is the provider's acceptance; only a provider delivery report (`recordNoticeDelivery`) makes it `DELIVERED`. No personal data in the table: the recipient is read from `order_contact` at send time, and an erased contact goes to attention as `NO_RECIPIENT` |
| legal | drafts only. `fn_publish_content_item` refuses legal pages (`LEGAL_PUBLICATION_NOT_ADMITTED`): legal text is still published by a code release with the legal-release admission (ART-359) |
| audit | each command writes an `editorial_audit` row (actor, login, draft revision, version, document sha256); a write to `tour`, `departure` or `content_item` outside the commands is audited as `DIRECT_WRITE`. The audit, revisions and execution changes refuse UPDATE, DELETE and TRUNCATE; notices refuse DELETE and only move forward |

Migration 0010 makes `(departure_id, from_version, draft_revision)` unique. An exact MATERIAL retry
(including a concurrent call) returns the same `changeId`, original affected-order count and version,
without duplicating order events or audit rows. It does so before recomputing order eligibility.
A different notice, EQUIVALENT classification or ordinary publication of that identity fails
`EXECUTION_CHANGE_CONFLICT`; stale version/revision tokens still fail their normal CAS checks.
A newly saved draft has a new revision. Move/cancel resolution is not implemented here.

**Required integration follow-ups (ART-363/365):**

- `recordNoticeDelivery` is a storage primitive; there is **no runtime delivery-report consumer**
  yet. ART-365 must connect a verified provider status source, correlate it to the stored
  `provider_job_id` and notice, and test delivery/bounce, unrelated-job and replay handling.
  Until then notices stay `ACCEPTED` after provider acceptance; Control Room must display that
  state without implying delivery. Sending and an HTTP acceptance response are not delivery evidence.
- ART-363 must validate a live authenticated OWNER session before either execution classification
  reaches the SQL command. `p_by`/`classified_by` is caller-supplied metadata, **not an authorization
  check**; `login_role` proves the database login only. The API must derive the actor from the
  session, persist a verifiable link from classification/change audit to its authentication event,
  and reject unauthenticated, expired and non-OWNER sessions even if they supply `by: 'owner'`.
  ART-365 must exercise this through the API; hiding a UI control is insufficient.

Remaining follow-ups: Control Room editor screens (ART-365) and ordinary
`bookingStatus`/`isListed` transitions (ART-366). The ART-362 writer is described above.

## Database roles

The owner applies migrations. There are five other logins, and none is a member of another's role:

| login | role | can | its credential |
|---|---|---|---|
| `commerce_runtime` | `commerce_app` | orders, personal data, erasure, read the switch | the service's `DATABASE_URL` (Coolify) |
| `commerce_operator_login` | `commerce_operator` | change the booking switch; read the local ЕИС filing packet/state; record manual ЕИС evidence | root-only `/etc/mikluha-commerce/operator.env` on the host, never in the service |
| `admin_runtime` | `admin_app` | Admin accounts (read), sessions (through `fn_admin_login`), login throttle, audit; content read/create/drafts through editorial functions; no publication or classification; never orders, personal data, payments, the switch or ЕИС | the Admin API's `ADMIN_DATABASE_URL` (Coolify, the Admin API application only) |
| `admin_publish_runtime` | `admin_publisher` | OWNER publication/classification, live-session locks and attested audit only; no login, draft editing, account management or commerce data | `ADMIN_PUBLISH_DATABASE_URL`, isolated Admin API application only; independent credential, never shared with `admin_runtime` |
| `admin_operator_login` | `admin_operator` | create Admin accounts, set passwords, reset TOTP, disable, revoke sessions, clear the throttle; sees no password hash, seed or token hash | root-only `/etc/mikluha-commerce/admin-operator.env` on the host, never in a service |

The service can't change the schema, delete orders or touch the switch. If the service is
compromised or broken, it still can't reopen sales an operator closed. `fn_set_sales_open` also
refuses any login that belongs to `commerce_app`, whatever the grants say; the editorial functions
refuse it too, and every Admin function refuses a login that belongs to commerce (and every
operator function, one that belongs to `admin_app` or `commerce_app`). Once, as the owner:

```sql
CREATE ROLE commerce_runtime LOGIN PASSWORD '<from the secret store>' IN ROLE commerce_app;
CREATE ROLE commerce_operator_login LOGIN PASSWORD '<from the secret store>' IN ROLE commerce_operator;
CREATE ROLE admin_runtime LOGIN PASSWORD '<from the secret store>' IN ROLE admin_app;
CREATE ROLE admin_publish_runtime LOGIN PASSWORD '<independent secret from the store>' IN ROLE admin_publisher;
CREATE ROLE admin_operator_login LOGIN PASSWORD '<from the secret store>' IN ROLE admin_operator;
```

`/etc/mikluha-commerce/operator.env` (root, 0600) holds one line:
`OPERATOR_DATABASE_URL=postgres://commerce_operator_login:…@<db host>/<db>`.
`/etc/mikluha-commerce/admin-operator.env` (root, 0600) holds one line:
`ADMIN_OPERATOR_DATABASE_URL=postgres://admin_operator_login:…@<db host>/<db>`.

## Public catalog (ADR v2.3 §2, TOUR-60)

```
GET  /public/v1/catalog       the public projection as one JSON document (src/public-api.ts)
```

What the SSR site renders on every request: `schema: "mikluha.public-catalog/1"` and the
published, listed tours, departures (with their contract only when the database found it complete),
organizers, reports and reviews of the `public_*` views, read as `commerce_app` in one READ ONLY
REPEATABLE READ transaction so a page never mixes two publishes. `Cache-Control: no-store`, no
cookie, no credential; drafts and history never reach it. The site calls it over the internal
network (`COMMERCE_PUBLIC_API_URL`); the data is public either way, the same rows new quotes are
priced from.

## Admin API (migration 0011, ART-363)

ADR v2.3 §7 and the shared standard (`adman-vps-infrastructure/runbooks/application-standards.md`
§1). The Control Room is static files behind its own Nginx (`../control-room`); that Nginx proxies
exactly `/api/` to the Admin API and nothing else. The Admin API is **the same image as this
service, a separate container and a separate login**: `node dist/bin/admin-api.js`. It is never
routed from `book.*` or the public site (the service has no `/api/` route at all), it refuses a
request for any host but the Control Room's, and it refuses to start if its login reaches anything
but `admin_app` or if a service, operator or provider credential is in its environment.

| | |
|---|---|
| login | password + TOTP code at every login (RFC 6238: SHA-1, 6 digits, 30 s, ±1 step; `src/admin/totp.ts`, the RFC vectors in `test/admin-totp.test.ts`). `fn_admin_login` spends the matching step under the row lock, writes `AUTH.LOGIN` and opens the session in one call: a code is accepted once, never at or before the last accepted step, and `admin_app` has no other way to create a session (a trigger keeps the step moving forward for every login) |
| seed | AES-256-GCM under `ADMIN_TOTP_KEY`, bound to the account id; the database never sees it in clear, the operator cannot read even the ciphertext |
| enrolment | open for 24 hours after `user add` or `totp reset`: password → QR code (otpauth URI, drawn in the browser) → the first valid code confirms it and signs in. Closed once confirmed. **No recovery codes, no passkey, no web disable** |
| lost device | `admin-operator totp reset` over SSH: the seed is deleted, every session revoked, a new 24-hour enrolment window opened, and the reset audited with the operator's name, reason and database login |
| throttle | one limit for password and code attempts together: 10 per 15 minutes per trusted client source (exactly one `X-Forwarded-For` address, as the booking limiter; anything else shares one bucket) and 20 per account, stored as HMAC buckets, never addresses or logins. In front of it, 120 attempts a minute for all clients together are refused in memory before anything is written, and the Control Room's Nginx caps `/api/auth/` globally (2/s, burst 20). Spent windows are pruned by a timer (indexed on `window_start`), never on the login path. `admin-operator throttle clear` lifts a lock-out |
| session | a random 256-bit token in `__Host-mk_admin` (HttpOnly, Secure, SameSite=Strict, Path=/). The database stores only its HMAC under a session key derived from `ADMIN_TOTP_KEY`, so a session row written with the database's credentials alone names no token anyone holds and is never accepted over HTTP. 30 minutes idle, 12 hours at most (a CHECK). Refresh rotates the token without extending the 12 hours; logout, revocation of another session, password change, disable and TOTP reset revoke. A session cannot exist without an enabled account and a confirmed second factor (a trigger) |
| writes | only with `Origin` = the Control Room origin, `Sec-Fetch-Site: same-origin` when sent, and a JSON body |
| roles | OWNER and EDITOR. Create and save drafts of tours, departures, reports, reviews, organizers and legal drafts: both. Publish any of them (offers, terms, privacy, refund/payment policy, PD consent) and classify execution changes: OWNER only. Audit: OWNER only. A refused permission is itself audited |
| publish and classify | `admin_app` has no EXECUTE on publish/classify. A disjoint `admin_publisher` login is used only by this transaction. Both credentials are checked at startup for capability isolation (no membership in each other, commerce or operator roles). OWNER only, decided from the live session alone: the editorial actor is the session's `admin:<login>`, never a name in the request, so an unauthenticated, expired, revoked or EDITOR session is refused even when it says `by: 'owner'`. Inside the publish transaction the account and then the session are locked and checked again, in the order every revocation takes them: a revocation or disable that committed after the permission check refuses the publish, one that arrives during it waits for it. An execution change on a sold departure takes `{classification, notice}` (ADR v2.3 §4; the rules are migration 0009/0010's `fn_publish_departure_change`). The publish and its Admin audit row commit together; that row names the session and its `AUTH.LOGIN` row (`details.sessionId`, `details.authAuditId`). Affected orders are shown as references and states only |
| audit | `admin_audit` is append-only for every login, including the owner; DB identity, timestamp and login are DB-stamped and API logins cannot supply or update them. Every API event has a random UUID `event_id`, unique in SQL, and a `key_id`. The HMAC binds both plus the DB login and the complete event content. Replaying a valid signature with its UUID fails uniqueness; replacing the UUID or login fails verification. The DB refuses unattested rows from either API capability. No password, code, seed, token or cookie is recorded. `GET /api/audit`: ATTESTED = known key and valid MAC, FORGED = known key and invalid MAC, UNVERIFIABLE = historical key unavailable, OPERATOR = no attestation from the owner/operator login. `AUTH.LOGIN` follows password + TOTP checks; publication records its session and authentication event |
| trust boundary | `admin_runtime` alone can write fake session/login rows, but cannot compute a valid token MAC, so HTTP refuses them; it cannot publish/classify through SQL, assume `admin_publisher` or grant itself publication. The separate publication credential is trusted API authority: its loss can bypass HTTP approval, and compromise of the Admin API process can reach both credentials and the keys. Keep both credentials in that isolated process only, with neither role membership shared. TOTP does not protect against code execution inside the API (application-standards §1) |


Operator commands, as root on the host, in a one-off container from the image on the database's
network (never `docker exec` into the Admin API). A password goes on stdin, never in argv:

```bash
admin() { docker run --rm -i --network "$NET" --env-file /etc/mikluha-commerce/admin-operator.env "$IMG" node dist/bin/admin-operator.js "$@"; }
admin status
read -rs PW && printf '%s' "$PW" | admin user add <login> --role OWNER --by <who>; unset PW
read -rs PW && printf '%s' "$PW" | admin user password <login> --by <who>; unset PW
admin totp reset <login> --by <who> --reason "<why>"
admin user disable <login> --by <who> --reason "<why>"
admin sessions revoke <login> --by <who> --reason "<why>"
admin throttle clear --by <who> --reason "<why>"
```

Admin API environment (Coolify, its own application; nothing here is shared with the service):

| variable | |
|---|---|
| `ADMIN_DATABASE_URL` | `admin_runtime`, a member of `admin_app` only |
| `ADMIN_PUBLISH_DATABASE_URL` | `admin_publish_runtime`, member of `admin_publisher` only; separate secret, never a member of `admin_app` |
| `ADMIN_AUDIT_KEY_ID` | unique nonsecret version ID for the active audit signing key (1–64 letters/digits/dot/underscore/hyphen) |
| `ADMIN_AUDIT_KEY` | independent 32-byte base64url audit signing key; required at startup, no fallback to the TOTP key |
| `ADMIN_AUDIT_PREVIOUS_KEYS` | JSON object mapping old key IDs to their original base64url audit keys, verification only (default `{}`). Preserve these keys for all retained events; never reuse an ID for different bytes. If a historical key is lost, its events remain UNVERIFIABLE and must not be called forged |
| `ADMIN_ORIGIN` | the Control Room's https origin, e.g. `https://admin.mikluha-maklai.ru` |
| `ADMIN_TOTP_KEY` | 32 random bytes, base64url (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). Encrypts every seed and, through HKDF, keys the session MACs and the throttle buckets. Losing or replacing it signs everyone out, makes every account re-enrol through `totp reset`; the independent audit keyring keeps historical audit verifiable. All keys need encrypted custody before deployment |
| `PORT` | default 3000 (the image's healthcheck port) |

## Commands

```bash
pnpm install --ignore-workspace          # in commerce/; it is not part of the site's workspace
pnpm test                                # needs TEST_DATABASE_URL (a disposable Postgres superuser)
pnpm run test:sabotage                    # ART-327; explicit loopback TEST_DATABASE_URL required
MIGRATION_DATABASE_URL=… node dist/bin/migrate.js
```

## Business-invariant sabotage (ART-327)

`test/business-invariants.test.ts` runs 26 negative/replay scenarios against the
real merchant code, migrated PostgreSQL and runtime/operator roles. Fixtures
contain synthetic traveller data only. Refref uses a loopback HTTP server;
Notisend uses injected responses. No live payment, email or EIS filing occurs.

`pnpm run test:sabotage` copies source, migrations and tests into a temporary
directory and applies 28 mutations one at a time: 26 merchant guards plus the
fake's saved-response replay and one-shot transport assumptions. Each is restored
before a green rerun. It requires a disposable PostgreSQL superuser endpoint on loopback;
each subprocess normally creates and drops its own database. Working source and deployed
schema are never modified. CI runs both the normal suite and sabotage step.
Anchor drift, a surviving mutation, the wrong assertion, setup/compile errors,
signals and timeouts fail the command. Only a named `BIxx` business assertion
counts as a killed mutation.

A subprocess killed by the 30-second timeout may not run its `after()` hook;
its test database can remain. Use a dedicated disposable PostgreSQL instance
and remove the entire instance after the run, including on failure. For example,
from `commerce/` (the subshell keeps its cleanup trap local):

```bash
(
  set -e
  docker run --rm -d --name mikluha-sabotage-pg -e POSTGRES_PASSWORD=synthetic-only \
    -p 127.0.0.1:55433:5432 postgres:16-alpine
  trap 'docker rm -f mikluha-sabotage-pg >/dev/null' EXIT
  until docker exec mikluha-sabotage-pg pg_isready -U postgres >/dev/null; do sleep 1; done
  TEST_DATABASE_URL=postgres://postgres:synthetic-only@127.0.0.1:55433/postgres pnpm run test:sabotage
)
```

| Invariants | Guards exercised |
| --- | --- |
| BI01–BI03 | Stop-sales in both lock orders; no overselling the final seat |
| BI04–BI05 | Stable attempt/body replay, ambiguous provider response, lost fulfilment ACK, one confirmation/outbox/EIS obligation under concurrent readbacks |
| BI06–BI09 | Live legal descriptor, accepted document, browser and resolution identity |
| BI10–BI12 | Receipt-email allowlist, immutable contract snapshot, exact paid amount |
| BI13–BI16 | Ambiguous Notisend response, crashed worker lease, EIS filing replay and stale reviewed packet |
| BI17–BI21 | Frozen offer/consent integrity, payment snapshot binding, immutable accepted application, unqualified refund policy stop |
| BI22–BI24 | Exact fulfilment ACK attempt identity, DELIVERED status and malformed bodies corrupted in transit |
| BI25–BI26 | Persisted bad ACK remains blocked and monitored; one corrupted transit response recovers from the saved correct ACK |

Commerce fulfils a paid order only after HTTP 200 confirms its exact attempt as
`DELIVERED`. An unusable ACK leaves it `PAID`, without a confirmation email.
Reconciliation repeats the same ACK identity: Refref replays the first saved
response for that key/body within its 24-hour idempotency retention window.
Repeating can recover from corruption in transit when the saved response is
correct; it cannot repair a bad response saved by Refref. That case stays
`PAID`, raises `paidNotFulfilled`, and needs investigation rather than a new key
or an assumed automatic recovery. The fake stores the first response separately
from a one-shot transit fault and tests both cases. Rejected answered ACKs log
only `fulfilment_ack_unusable`, the order reference and HTTP status; response
bodies and personal data are excluded. The EIS filing obligation is already due
from the independently proven payment and remains `EIS_PENDING`.

**Acceptance gaps:** no merchant refund adapter exists in this tree, so duplicate
or lost-ACK refund execution is untested. Provider callbacks, actual payment and
receipt deduplication belong to Refref; the fake server establishes merchant
replay and payload behaviour only. EIS tests record manual filing evidence,
without submitting to the external portal. ART-275/285/412 qualification and
ART-362 checkout from immutable contracts remain separate. Keep ART-327 open
until these remaining acceptance points have independent evidence; this suite
is not production financial-flow admission.

The booking switch (refref `ops/runbooks/stop-sales.md`), as root on the host. It runs in a
**one-off container** from the service's own image, on its network, never by `docker exec` into the
service: a process there runs as the service's uid, and the service could read its environment.

```bash
C=<service container>
IMG=$(docker inspect -f '{{.Image}}' "$C")
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$C")
sales() { docker run --rm --network "$NET" --env-file /etc/mikluha-commerce/operator.env "$IMG" node dist/bin/sales.js "$@"; }
sales status
sales close --by <who> --reason "<why>"
sales open  --by <who> --reason "<why>"
```

Manual ЕИС filing uses the same isolated image/network/operator env boundary. It never calls ЕИС;
`submit` records what the operator already did in the ЕИС personal account. `packet` prints personal
data to the local terminal and must never be redirected or pasted into logs, CI, GitHub or Linear.
The complete workflow and first-sale evidence checklist are in
[`runbooks/eis-manual-filing.md`](runbooks/eis-manual-filing.md).

```bash
eis() { docker run --rm --network "$NET" --env-file /etc/mikluha-commerce/operator.env "$IMG" node dist/bin/eis.js "$@"; }
eis status [<mk-order-ref>]
eis packet <mk-order-ref>
eis submit <mk-order-ref> --number '<actual-number>' --revision '<packet-revision>' --by '<who>' --confirmed-in-eis-lk
eis needs-update <mk-order-ref> --by '<who>' --reason '<why>'
```

Locally, start a disposable Postgres for the tests:

```bash
docker run -d --rm --name commerce-test-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
```

## Runtime environment

| variable | |
|---|---|
| `DATABASE_URL` | the runtime role |
| `COMMERCE_ENVIRONMENT` | `STAGING` or `PRODUCTION`. PRODUCTION refuses to start unless content is `launchReady` and its refund workflow is qualified |
| `CONTENT_DIR` | set by the image: the site's `content/` from the same commit |
| `SOURCE_COMMIT` | required image build arg. The commerce image stores it read-only in `/app/identity/identity.json`; production has no runtime override |
| `COMMERCE_ORIGIN` | fixed in production: `https://book.mikluha-maklai.ru` |
| `SITE_ORIGIN` | fixed in production: `https://mikluha-maklai.ru` |
| `REFREF_API_BASE` | fixed in production: `https://api.refref.ru/v1-rc` |
| `REFREF_CHECKOUT_ORIGIN` | fixed in production: `https://checkout.refref.ru` |
| `REFREF_BUSINESS_ID`, `REFREF_BUSINESS_SLUG` | Mikluha's Refref Business |
| `REFREF_API_KEY` | its Business API key (a secret) |
| `NOTISEND_API_KEY` | Notisend API key (a secret; sent as `Authorization: Bearer`) |
| `NOTISEND_FROM_EMAIL`, `NOTISEND_FROM_NAME` | verified transactional sender (domain confirmed in Notisend) |
| `NOTISEND_REPLY_TO` | optional reply address, sent as the `Reply-To` header |

## Legal-release deployment gate

The site publishes `/release.json`; commerce `/identity` reports the corresponding source commit,
`termsRef`, `termsHash`, `pdConsentRef` and `pdConsentHash`. In production, commerce compares all
five immutable values with the live site at startup, readiness, reservation, and payment. Drift
fails closed. The owner-run deploy, backup, logging, legal/content and first-sale gates are in
[`runbooks/production-launch.md`](runbooks/production-launch.md).

The four network addresses above remain configurable in staging. Production compares their
normalized URLs against the fixed values and refuses startup on any host, port, path, credential,
query or fragment mismatch.

Schema-8 digest trust boundary: the trusted `reserve()` producer computes the JCS SHA-256. SQL
checks snapshot shape/order consistency and digest format, not JSON-to-digest equality.
`contractSnapshotIntact` is the independent verifier and refuses an otherwise well-formed snapshot
with a wrong digest, including one inserted by a direct owner writer. DB-backed document/reservation
writers must invoke it and bind the accepted immutable revision before admission (ART-358/362).
The current content-backed document path is not claimed to enforce this future gate.

## Immutable migration history (ART-317)

For a new database, [TOUR-57 clean-schema preparation](runbooks/clean-schema.md)
replays the complete locked journal in isolated PostgreSQL 16 and exports a
review manifest and schema-only SQL. It uses the existing migrations unchanged;
installation and target recovery evidence remain separate actions.

`migrations/migration.lock` fixes the filename, version and SHA-256 of every SQL file. Append a
new journal entry, SQL file and lock entry together; never rewrite a committed entry. Startup
and the migrator validate the complete directory before using it. The migrator also verifies
that the database journal is a contiguous, byte-identical prefix before applying anything.

CI finds all merge bases of the event's exact base/head SHAs and checks every commit against
**each parent** on both divergent branches, including intermediate edits later reverted and lock
removal on a side branch. The latest base's migrations must also be an unchanged prefix of HEAD.
Docs/CMS-only changes on main do not require a rebase. A missing or conflicting base migration
fails with `MIGRATION_BASE_NOT_INCLUDED`: merge/rebase and synchronize migrations explicitly.
Before the first lock, committed SQL bytes are the bootstrap authority. Run from `commerce/`:

```sh
pnpm exec tsx scripts/check-migration-history.ts BASE_SHA HEAD_SHA
```

The schema-7 upgrade test compares all old journal fields, including timestamps, before and
after the forward upgrade. This is isolated test evidence; it does not apply production SQL.


## Forward-compatible schema readiness (ART-318)

Migration 0012 introduces `schema_migration_compatibility`, written only by the owner migrator.
Commerce and Admin API read the same contiguous migration history and verify their entire bundled
prefix's filenames and checksums. Every ahead migration needs its own matching attestation and an
explicit approval for the **full source SHA from the old image's immutable identity file**. No
approval is inferred from a higher version, a mutable environment variable, a tag or a recent CI run.
Database-behind, missing/unknown history, altered checksums, gaps and unapproved runtimes remain
`NOT_READY`. A null or abbreviated identity cannot receive a forward approval.

From 0012 onward every lock entry must contain a classification:

```json
"compatibility": {
  "runtimeCommits": [],
  "evidence": "Incompatible until the actual old image and this migration are qualified."
}
```

An empty list means incompatible. A compatible migration lists only the exact tested old source
commits; `evidence` records the proof location, old image digest, new migration checksum and exercised
operations. SQL and classification become immutable together. The migrator validates prior
attestations on rerun and inserts new SQL, journal and attestation in one transaction. Runtime roles
have SELECT only. The database owner is the authority for applying reviewed migrations; database
owner compromise is outside the runtime permission boundary.

Deployment order:

1. Land and deploy the protocol-aware baseline with schema 0012. Existing pre-protocol images still
   require exact schema equality and **cannot** be made forward-compatible by registry entries.
2. Qualify each proposed future migration using the actual previous image digest/source SHA. Include
   booking, payment/reconciliation, workers and Admin operations affected by that SQL, negative
   permissions/integrity tests, recovery and application rollback. Commit the exact approval and
   evidence with the new migration. This PR approves **no real ahead migration**.
3. Apply that release's migrations as owner. The previous protocol-aware image remains ready only
   if **every** ahead version explicitly approves it. Then install the exact new image. On application
   rollback keep compatible SQL; do not delete journal rows or run the old migrator backwards.
   Incompatible migrations require a coordinated release; this gate provides no availability promise.
4. Recheck `/identity`, `/readyz`, and independent legal-release admission. Commerce and the public
   site's legal identity must still agree exactly; schema compatibility does not authorize serving
   different legal releases. Migration, deployment, recovery qualification and sales admission are
   separate owner-authorized actions.

Integration CI tests/builds the default merge-tree, labelled with its actual `github.sha`.
The separate `commerce-image` job checks out the exact PR HEAD, verifies SHA and clean tracked
source with `node scripts/check-image-source.mjs EXPECTED_HEAD_SHA`, builds the image with that SHA,
pins its Docker image ID, and runs
`pnpm exec tsx scripts/qualify-schema-image.ts IMAGE EXPECTED_HEAD_SHA`. The probe independently
compares the image's immutable identity with the declared SHA. Merge-tree results are not proof
for a differently labelled HEAD image. After merge, a release candidate needs separate qualification
of the actual release SHA/tree/digest.

The image probe intentionally asserts bundled schema **12**: when adding 0014, revise the baseline,
forward fixture and compatibility qualification together; do not merely remove that assertion.

 A disposable internal Docker network contains
only PostgreSQL and that unchanged image, with no host mounts, published ports or external provider
access. Its bundled schema stays 12 while an additive **test-only** schema 13 is applied. It proves
readiness/identity, reservation, contract readback, order state, maintenance and negative/rollback
cases. The fixture proves this protocol for the tested operations; it does not qualify arbitrary
future SQL, real payments, a production deployment or recovery. PostgreSQL integration tests also
exercise the Admin role, immutable classification, failed-SQL rollback and tampering.

### Operation admission and incompatible migration drain

`/readyz` is a routing signal. Separately, schema admission checks **each** commerce/Admin application
request and **each** background step (reconciliation, maintenance, email outbox, execution notices,
Admin throttle pruning and after-response arrival claims). There is no cached READY. A mismatch or
unavailable database refuses HTTP with 503 before route execution and skips worker callbacks without
side effects. `/healthz` and `/identity` stay available for diagnosis. Known attestations from 0012
must also exactly match the bundled lock's filename, checksum, runtime commits and evidence.
The legal-release gate remains independent: existing obligations can still be reconciled/mailed
when only the site's legal identity is unavailable or different. Commerce `/readyz` reads schema
once per request and then performs the independent legal check; draining remains NOT_READY. Admission
has no READY cache. Arrival's per-attempt ceiling starts inside `attempt()`, after admission; the
schema check can add scheduling latency but does not shorten that internal ceiling.

Admission checks are not a lock against owner DDL and do not cancel work already admitted. Before
**incompatible SQL**, including the first protocol upgrade:

1. Remove traffic and disable automatic restart/deployment of all old commerce and Admin API replicas.
2. Send SIGTERM (or SIGINT) to every instance. Shutdown refuses new admission, stops timers, waits for
   admitted HTTP and worker operations and pre-registered after-response work, then closes pools and exits 0.
   Set the supervisor's stop timeout to allow provider timeouts and the current worker batch to finish.
3. Require successful graceful exit of every instance. Independently verify there are no old runtime
   sessions or outstanding external operations. A timeout, SIGKILL, failed exit or unknown provider
   outcome is **not** a successful drain: reconcile/resolve it before applying SQL. Do not use a 503
   response alone as evidence that runtime work has stopped.
4. Take/verify the required recovery evidence, apply migrations as owner, and start only the admitted
   exact-SHA runtime. Recheck identity, schema and legal readiness before restoring traffic. Rollback
   to a schema-incompatible image requires its own coordinated recovery plan, never journal deletion.

Compatible, qualified SQL may be applied while the explicitly approved old image is operating;
new operations recheck schema admission, while already-admitted operations may finish. The negative
integration tests check direct HTTP refusal, unchanged order/outbox state, zero outbound sends,
per-step rechecks and drain races. These checks do not authorize production rollout.

Arrival tasks are tracked when scheduled, **before** response close. SIGTERM/SIGINT stops registration
of new work. A still-live HTTP request admitted before shutdown can also register its own ticket
before its handler returns. This permission is async-context scoped and revoked on return, including
for detached descendants; unrelated callbacks and new requests cannot borrow it. Drain waits for
these late registrations as well. A registered ticket waits for response close and rechecks live schema even while
ordinary admission returns RUNTIME_DRAINING, then completes its bounded attempt. Fresh proofs
coalesced into an already registered task remain part of that drain obligation. There is no blanket
schema bypass during shutdown. Tests deliver real SIGTERM before close, then verify exactly one
claim and that drain waits; incompatible schema still prevents the claim. SIGKILL/crash/forced timeout
can lose memory-only proofs. Drain guarantees the registered attempt on a compatible schema, not a
remote ACK or durable delivery after an ambiguous transport failure.

Residual repository risk: this workflow gates pull requests only; an authorized direct push to main
can bypass history CI (relevant especially to fresh databases). Path-scoped branch rules for
`commerce/migrations/**`, preserving CMS writes to `content/**`, are a separate owner-controlled
follow-up. No repository access rules are changed here.

The ART-327 business sabotage harness rehashes SQL mutants only in its disposable scratch copy so
that setup reaches the selected business assertion. It restores both SQL and scratch lock after
each mutant. This does not change the committed lock or waive the DAG/history sabotage checks.

### Direct image pipeline (TOUR-63)

The [media contract and runbook](media/README.md) define the authenticated Control Room endpoints,
separate media-only worker/S3 principal, bounded Linux decoder, rights/public projection and confirmed
withdrawal lifecycle. Migration 0018 is append-only. Source-only work does not enroll credentials,
apply the migration, install the worker or qualify Cloud.ru. VPS-17 is not a stage-1 dependency.
### TOUR-64 Stage A / TOUR-65 Admin contract

Forward migration `0019_control_room_editors_and_departure_controls.sql` adds
publisher-only departure controls and versioned legal approval. Historical
migration bytes remain unchanged. No host or production database was changed.

| Endpoint | OWNER command / read model |
|---|---|
| `GET /api/departure-controls` | redacted global-open flag and recent batch receipts; global switch remains operator-only |
| `POST /api/departures/<id>/controls` | `expectedVersion`, optional `bookingStatus` (`OPEN`/`CLOSED`), `capacity`, `isListed`; no CANCELLED setter |
| `POST /api/departure-controls/pause-all` | one transaction; returns immutable `batchId` and closed count |
| `POST /api/departure-controls/<batchId>/resume` | rechecks current admission; returns opened count and skipped IDs/reasons |
| `POST /api/content/<id>/publish-legal` | `expectedDraftRevision`, `expectedPublishedVersion`, `effectiveOn`, explicit approval; immutable document/text hashes |

All privileged commands recheck the live session under account/session locks and
commit an attested AUTH.LOGIN-linked audit in the same transaction. The API actor
comes from the session. Raw sales-switch, purchase and personal-data tables stay
unreadable to Admin; `admin_sales_status` and `admin_departure_inventory` expose
only the required operational values. Capacity consumes migration 0017's canonical
`fn_departure_taken_seats`, with no separate allocation ledger. OPEN takes the
global switch share lock, then the batch barrier, row and existing departure
advisory lock. Batch rows are locked in ID order; manual control touches supersede
a prior batch, including CLOSED→CLOSED. Uncertain payment states are never freed.

The Stage A Admin publication entry refuses schedule/contract changes if any order
exists; underlying Stage B primitives and historical snapshots remain intact.
Legal approval is separate from checkout release selection and processing-
instruction signature. `/public/v1/catalog` adds `legalPages`: slug/title/body,
publishedVersion, documentSha256, textSha256 and effectiveOn. It excludes drafts,
future-effective versions and private approval notes. The SSR consumer must adopt
this feed in its separately reviewed integration.

TOUR-63's `0018_direct_s3_media.sql` precedes this suffix. Never rewrite an already
committed migration on main or an applied database journal. This contract does not
claim qualification of the media pipeline or clean-schema installation.
