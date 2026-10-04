# mikluha-commerce

Mikluha's booking and payment service (`docs/DECISIONS.md` #9, Linear ART-47). The public site stays
static; everything that sells a trip lives here, with its own Postgres.

**Done:**
- slice 1: orders and seats, the personal data an order needs and its erasure, the booking switch,
  health, readiness and identity;
- slice 2: the Refref checkout. Handoff, referral resolution, the final price, one frozen attempt,
  the PROVIDER payment session, and read-back-driven payment and fulfilment.

**Next:**
- the booking page (slice 3);
- deploy, backups and monitoring (slice 4).

## Rules the code keeps

| | |
|---|---|
| price | the full `price` of the departure for every seat, frozen on the order; `prepaymentAmount` is never used |
| what is sold | an OPEN, listed departure with a `price` and a `capacity` that has not started; demo departures only in STAGING |
| seats | counted here, never in the CMS; checked under a per-departure lock; RESERVED for 30 min, PAYMENT_PENDING and HELD never freed by time |
| personal data | contact: full name, phone, email. Passengers: full name, plus a date of birth only where the departure sets `requiresDateOfBirth`; otherwise it is refused. Adults only. Nothing personal in logs |
| erasure | unpaid (EXPIRED, CANCELLED): within 24 h of ending. A trip (PAID, FULFILLED, REFUNDED): 90 days after it ends. Never under `legal_hold`, never while money is unresolved |
| booking switch | closed on a new database. Only an operator login (`commerce_operator`) can change it, through `fn_set_sales_open`, which records who, why and the database login. The service can read it, never change it. A sale reads it under a lock in its own transaction |

## Checkout (refref docs/28)

```
GET  /book?departure=<slug>   form: contact, passengers, terms (slice 3 restyles it)
POST /orders                  reserve → state cookie → Refref attribution handoff
GET  /return?rt=&state=       state checked against this browser's cookie → referral resolution
GET  /orders/<ref>            read back from Refref first; the final price to accept, or the outcome
POST /orders/<ref>/pay        freeze the snapshot → the one attempt → payment session → the bank
```

| | |
|---|---|
| what is paid | one FULL / ORCHESTRATED / PROVIDER obligation: the full price minus any referral discount. One fiscal item of quantity 1 equal to the payment, USN_INCOME, FULL_PREPAYMENT, SERVICE, no VAT. This is the Alfa path that was qualified, and nothing else is built (`src/snapshot.ts`). The digest is computed here independently and checked against Refref's own vectors |
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
| `COMMERCE_ORIGIN` | this service's public origin |
| `REFREF_API_BASE` | e.g. `https://api.refref.ru/v1-rc` |
| `REFREF_CHECKOUT_ORIGIN` | e.g. `https://checkout.refref.ru` |
| `REFREF_BUSINESS_ID`, `REFREF_BUSINESS_SLUG` | Mikluha's Refref Business |
| `REFREF_API_KEY` | its Business API key (a secret) |
