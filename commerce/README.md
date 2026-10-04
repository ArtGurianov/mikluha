# mikluha-commerce

Mikluha's booking and payment service (`docs/DECISIONS.md` #9, Linear ART-47). The public site stays
static; everything that sells a trip lives here, with its own Postgres.

**Slice 1 (this):**
- orders and seats;
- the personal data an order needs, and its erasure;
- the booking switch;
- health, readiness and identity.

**Next:**
- the Refref adapter (slice 2);
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
| booking switch | closed on a new database; `fn_set_sales_open` records who and why; a sale reads it under a lock in its own transaction |

## Database roles

The owner applies migrations. The service connects as a login role that only belongs to
`commerce_app`. That role cannot change the schema, delete orders, or set the switch except
through the function. Once, as the owner:

```sql
CREATE ROLE commerce_runtime LOGIN PASSWORD '<from the secret store>' IN ROLE commerce_app;
```

## Commands

```bash
pnpm install --ignore-workspace          # in commerce/; it is not part of the site's workspace
pnpm test                                # needs TEST_DATABASE_URL (a disposable Postgres superuser)
MIGRATION_DATABASE_URL=… node dist/bin/migrate.js
DATABASE_URL=… node dist/bin/sales.js status | open|close --by <who> --reason "<why>"
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
