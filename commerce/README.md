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

**Next:**
- manual ЕИС filing state and operator evidence (slice 3d);
- immutable image-file build identity, deploy, backups, merchant-order attempt recovery,
  monitoring and the first real payment (slice 4).

## Rules the code keeps

| | |
|---|---|
| price | the full departure price for every seat, frozen on the order; online checkout never collects a partial advance |
| what is sold | an OPEN, listed departure with a `price` and a `capacity` that has not started; demo departures only in STAGING |
| seats | counted here, never in the CMS; checked under a per-departure lock; RESERVED for 30 min, PAYMENT_PENDING and HELD never freed by time |
| personal data | the customer (Заказчик) is tourist №1, plus a phone and an email; a customer who does not travel is not booked online. Every tourist: what ЕИС «Электронная путёвка» requires (ПП №417): full name, date of birth, citizenship, and an identity document (type, series where it has one, number). Nothing more: no issue date, issuer, address or scans. Adults only. Nothing personal in logs |
| PD consent | a separate published `soglasie-pd` artifact, not the offer. The booking form carries its version reference and hash and requires its own checkbox. Commerce validates them, stores the authoritative text, reference, hash and acceptance time, and verifies the evidence again before payment. It is never included in Refref's `legalReleaseHash` |
| transactional email (3c) | one Postgres outbox row is inserted with FULFILLED in the same transaction; an async worker sends through UniSender Go with one stable idempotency key and stores the provider `job_id`. Ambiguity retries the same identity; definitive rejection becomes operator attention. Contract/order mail has no unsubscribe mechanism; marketing is a separate class |
| booking rate limit (3c) | trust only exactly one valid `X-Forwarded-For` IP from the single Coolify/Traefik hop; missing, malformed or multiple values share one conservative untrusted-ingress bucket. The in-memory store has TTL eviction and a hard size bound. A body-size limit and order-scoped controls remain separate protections. SmartCaptcha is reserved for observed abuse, not launch |
| contract | the offer (`content/legal/oferta.yml`) plus the order's **Заявка на бронирование** (`src/zayavka.ts`), built from the order, its tourists and the tour's and departure's `contract` data in the CMS. A departure without complete contract data is not sold. The authoritative offer text/ref/hash are frozen on reservation and re-hashed before payment. The Заявка is rendered when the price is resolved, shown before paying exactly as stored, and accepted by paying; `/pay` carries its hash, and a different one is refused. Both frozen documents remain available on the cookie-protected order page and through the high-entropy bearer link in the confirmation email; only the token hash remains in `orders`, and the outbox drops its plaintext token when UniSender accepts the mail. After payment the database forbids changing the Заявка. Erased 3 years after the contract ended (24 hours after an unpaid order ends); its hash stays |
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
| refunds at launch | only the qualified full PROVIDER refund. Mikluha waives deductions of actual expenses and returns the full paid amount when a refund is approved. Partial refunds remain a later end-to-end qualification task |
| PAID | only from Refref's read-back: the obligation SATISFIED by a SUCCEEDED payment of exactly the payable amount. The customer's return from the bank decides nothing |
| no second payment | one attempt per order, created with the fixed key `mk-attempt:<ref>`; an unanswered request is repeated identically. Sessions are only re-requested on that attempt: Refref replays a live payment and starts a new one only after a definitive failure |
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
| `commerce_operator_login` | `commerce_operator` | change the booking switch, read its history | root-only `/etc/mikluha-commerce/operator.env` on the host, never in the service |

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

Locally, start a disposable Postgres for the tests:

```bash
docker run -d --rm --name commerce-test-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
```

## Runtime environment

| variable | |
|---|---|
| `DATABASE_URL` | the runtime role |
| `COMMERCE_ENVIRONMENT` | `STAGING` or `PRODUCTION`. PRODUCTION refuses to start unless the content is `launchReady` |
| `CONTENT_DIR` | set by the image: the site's `content/` from the same commit |
| `SOURCE_COMMIT` | build arg, reported by `/readyz` and `/identity` |
| `COMMERCE_ORIGIN` | this service's public origin: `https://book.mikluha-maklai.ru` |
| `SITE_ORIGIN` | the public site, where the legal pages are: `https://mikluha-maklai.ru` |
| `REFREF_API_BASE` | e.g. `https://api.refref.ru/v1-rc` |
| `REFREF_CHECKOUT_ORIGIN` | e.g. `https://checkout.refref.ru` |
| `REFREF_BUSINESS_ID`, `REFREF_BUSINESS_SLUG` | Mikluha's Refref Business |
| `REFREF_API_KEY` | its Business API key (a secret) |
| `UNISENDER_GO_API_KEY` | UniSender Go transactional API key (a secret) |
| `UNISENDER_GO_FROM_EMAIL`, `UNISENDER_GO_FROM_NAME` | verified transactional sender |
| `UNISENDER_GO_REPLY_TO` | optional reply address |

## Legal-release deployment gate

`/identity` reports `termsRef`, `termsHash`, `pdConsentRef` and `pdConsentHash`. Slice 4 must publish
the public legal pages and deploy commerce from the same admitted source commit, compare those four
values with the public `oferta` and `soglasie-pd`, and only then open sales. The two deployments must
not drift: commerce must never record an older legal version than the public page the customer saw.
