# mikluha-commerce

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
  UniSender Go, bounded proxy-aware booking throttling, and site-matched customer pages with access
  to the exact offer and Заявка frozen on the order.
- slice 3d: manual ЕИС filing state, operator-only submission evidence, fail-closed stale-filing
  detection, and the first-sale filing checklist.
- slice 4 application controls: immutable site/commerce build identities, live legal-release
  admission at startup/readiness/reservation/payment, merchant-order recovery after an ambiguous
  attempt create, aggregate PD-free monitor signals, and the owner-run production launch gate.

**Next:**
- qualify the selected documented-expense refund workflow separately; obtain real commercial
  facts, signed processing instruction and remaining legal/provider evidence. Refref host
  integration #48/#49 is merged; schema-6 restore proofs and timers have passed, but migration 0007
  needs owner-only application and fresh recovery evidence before future admission. Mikluha
  commerce is undeployed; monitor admission, sales and payments remain closed.

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
| transactional email (3c) | one Postgres outbox row is inserted with FULFILLED in the same transaction; an async worker sends through UniSender Go with one stable idempotency key and stores the provider `job_id`. UniSender deduplicates that key for only one minute: first submission time is persisted, retries run every 10 s and may start only in a conservative first-40-second window. A late/delayed retry, expired lease outside the window, or duplicate-key error 1573 becomes operator attention without another send. Contract/order mail has no unsubscribe mechanism; marketing is a separate class |
| booking rate limit (3c) | trust only exactly one valid `X-Forwarded-For` IP from the single Coolify/Traefik hop; missing, malformed or multiple values share one conservative untrusted-ingress bucket. The in-memory store has TTL eviction and a hard size bound. A body-size limit and order-scoped controls remain separate protections. SmartCaptcha is reserved for observed abuse, not launch |
| ЕИС filing (3d) | the first proven paid state atomically creates `EIS_PENDING`. Only an explicit `commerce_operator` action after manual submission in the ЕИС personal account records `EIS_SUBMITTED` and its actual electronic-voucher number. One normalized number is lifetime-owned by one order, including historical numbers after corrections, and concurrent cross-order claims fail closed. Submission must name the material revision printed with the reviewed filing packet; an intervening change is refused as `EIS_PACKET_STALE`. A later contract/tourist correction or refund becomes `EIS_NEEDS_UPDATE`; commerce never claims it filed anything and has no ЕИС API integration |
| contract | the offer (`content/legal/oferta.yml`) plus the order's **Заявка на бронирование** (`src/zayavka.ts`), built from the order, its tourists and the tour's and departure's `contract` data in the CMS. A departure without complete contract data is not sold. The authoritative offer text/ref/hash are frozen on reservation and re-hashed before payment. The Заявка is rendered when the price is resolved, shown before paying exactly as stored, and accepted by paying; `/pay` carries its hash, and a different one is refused. Both frozen documents remain available on the cookie-protected order page and through the high-entropy bearer link in the confirmation email; only the token hash remains in `orders`, and the outbox drops its plaintext token when UniSender accepts the mail. The bearer token/path must be redacted or excluded from live Traefik/Coolify access logs. After payment the database forbids changing the Заявка. Erased 3 years after the contract ended (24 hours after an unpaid order ends); its hash stays |
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
| what is paid | one FULL / ORCHESTRATED / PROVIDER obligation: the full price minus any referral discount. One fiscal item of quantity 1 equal to the payment, USN_INCOME, FULL_PREPAYMENT, SERVICE, no VAT. This is the Alfa path that was qualified, and nothing else is built (`src/snapshot.ts`). The digest is computed here independently and checked against Refref's own vectors |
| refund qualification | only the full PROVIDER refund is technically qualified. The published documented-expense policy is not: launch and new payments are blocked until its separate end-to-end workflow qualification; this PR implements no partial refunds |
| PAID | only from Refref's read-back: the obligation SATISFIED by a SUCCEEDED payment of exactly the payable amount. The customer's return from the bank decides nothing |
| no second payment | one attempt per order, created with the fixed key `mk-attempt:<ref>`; an unanswered request is repeated identically. Sessions are only re-requested on that attempt: Refref replays a live payment and starts a new one only after a definitive failure |
| ambiguous create recovery | after an unanswered create, read the Refref merchant-order projection and accept exactly one attempt whose `snapshotHash` and `referralResolutionId` match the frozen order. A foreign/mismatched projection is HELD; no payment session is started |
| seats of a payment | freed only when Refref confirms the attempt can't settle. Either the cancel answers CANCELLED (tried after 60 minutes OUTSTANDING), or the attempt reads back CANCELLED or EXPIRED without money. Anything inconsistent is HELD, with seats kept |
| fulfilment | PAID → `fulfillment-ack` DELIVERED (key `mk-fulfil:<ref>`) → FULFILLED |
| personal data to Refref | the receipt email in the payment session, which PROVIDER fiscalization requires. Nothing else |
| the switch | closed: no new payment session. Reading back, fulfilment and cancellation go on |

**The Refref Business needs:**
- an API key with `integrations:checkout` and `integrations:fulfillment`;
- `COMMERCE_ORIGIN` verified, with destination paths `/return` and `/orders/`;
- an Offer per tour slug (`offerRef`) wherever a campaign should apply. The departure is the
  `unitRef`.

## Database roles

The owner applies migrations. There are two other logins, and neither is a member of the other's role:

| login | role | can | its credential |
|---|---|---|---|
| `commerce_runtime` | `commerce_app` | orders, personal data, erasure, read the switch | the service's `DATABASE_URL` (Coolify) |
| `commerce_operator_login` | `commerce_operator` | change the booking switch; read the local ЕИС filing packet/state; record manual ЕИС evidence | root-only `/etc/mikluha-commerce/operator.env` on the host, never in the service |

The service can't change the schema, delete orders or touch the switch. If the service is
compromised or broken, it still can't reopen sales an operator closed. `fn_set_sales_open` also
refuses any login that belongs to `commerce_app`, whatever the grants say. Once, as the owner:

```sql
CREATE ROLE commerce_runtime LOGIN PASSWORD '<from the secret store>' IN ROLE commerce_app;
CREATE ROLE commerce_operator_login LOGIN PASSWORD '<from the secret store>' IN ROLE commerce_operator;
```

`/etc/mikluha-commerce/operator.env` (root, 0600) holds one line:
`OPERATOR_DATABASE_URL=postgres://commerce_operator_login:…@<db host>/<db>`.

## Commands

```bash
pnpm install --ignore-workspace          # in commerce/; it is not part of the site's workspace
pnpm test                                # needs TEST_DATABASE_URL (a disposable Postgres superuser)
MIGRATION_DATABASE_URL=… node dist/bin/migrate.js
```

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
| `UNISENDER_GO_API_KEY` | UniSender Go transactional API key (a secret) |
| `UNISENDER_GO_FROM_EMAIL`, `UNISENDER_GO_FROM_NAME` | verified transactional sender |
| `UNISENDER_GO_REPLY_TO` | optional reply address |

## Legal-release deployment gate

The site publishes `/release.json`; commerce `/identity` reports the corresponding source commit,
`termsRef`, `termsHash`, `pdConsentRef` and `pdConsentHash`. In production, commerce compares all
five immutable values with the live site at startup, readiness, reservation, and payment. Drift
fails closed. The owner-run deploy, backup, logging, legal/content and first-sale gates are in
[`runbooks/production-launch.md`](runbooks/production-launch.md).

The four network addresses above remain configurable in staging. Production compares their
normalized URLs against the fixed values and refuses startup on any host, port, path, credential,
query or fragment mismatch.
