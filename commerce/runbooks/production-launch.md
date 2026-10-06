# Production launch: Mikluha commerce

This is the owner-run gate for ART-47 slice 4. It does not authorize a deployment, a database
write, opening sales, provider configuration, or a real payment. Keep sales closed until every
pre-live item below has evidence.

## Fixed identities and sequence

- Public site: `https://mikluha-maklai.ru`
- Commerce: `https://book.mikluha-maklai.ru`
- Both images must be built from the same reviewed 40-character merge commit.
- The site image publishes that commit and the exact `oferta` / `soglasie-pd` identities at
  `/release.json`.
- The commerce image reads its commit from `/app/identity/identity.json`. Production has no
  runtime `SOURCE_COMMIT` fallback.
- Commerce verifies the live site descriptor at startup, on readiness, before every reservation,
  and again before a reserved order can start payment.

Deploy the site first and commerce second. During the interval, an old commerce deployment may
fail readiness or refuse new reservations/payments; that is the intended fail-closed behavior.
Never open sales to make a mismatched deployment look healthy.

## 0. Hard STOP conditions

Do not deploy or take a real payment while any item below is unresolved:

- the reviewed slice-4 application PR is not merged;
- the separate Refref host backup/monitor PR is not merged, installed, and restore-tested;
- `content/site-settings.yml` is not `launchReady: true`;
- the offer selects `DOCUMENTED_EXPENSES` but expense calculation, partial-return authorization,
  provider/fiscal execution, idempotency, reconciliation and evidence have not been separately
  implemented and qualified end-to-end. This PR deliberately refuses new reservations/payments
  and production startup for that policy; setting `launchReady` or the sales switch cannot qualify it;
- any OPEN production departure is demo data or lacks real tour, accommodation, carrier, service,
  capacity, price, or other contract facts;
- the PD-processing instruction from ООО «ООО МИКЛУХА МАКЛАЙ» to ИП Гурьянов А.А. is not signed;
- Mikluha's own Roskomnadzor notification and the Mikluha UniSender account's acceptance of the
  applicable Russian-processing terms/version have no owner-held evidence;
- actual service-completion recording and closing-receipt execution are not separately qualified;
- the Mikluha database backups do not use their own host paths, S3 prefix, and
  `mikluha-recovery` age identity;
- live proxy/application logs retain an unredacted `/documents/<token>` request;
- the Refref Business, origins, destinations, API scopes, or Offers are incomplete;
- either public address lacks valid TLS or redirects/downgrades away from HTTPS;
- `/release.json` and `/identity` do not show the same reviewed source commit and legal identities;
- production merchant conformance has not passed.

The committed content is intentionally not changed by this runbook. The owner must supply and
review the real commercial facts; an agent must not invent them.

## 1. Build immutable candidates

From a clean checkout of the reviewed merge commit:

```bash
RELEASE_SHA=$(git rev-parse HEAD)
test "${#RELEASE_SHA}" -eq 40
test -z "$(git status --porcelain --untracked-files=no)"

docker build --pull \
  --build-arg DEPLOY_ENV=production \
  --build-arg SOURCE_COMMIT="$RELEASE_SHA" \
  -t "mikluha-site:$RELEASE_SHA" .

docker build --pull \
  -f commerce/Dockerfile \
  --build-arg SOURCE_COMMIT="$RELEASE_SHA" \
  -t "mikluha-commerce:$RELEASE_SHA" .
```

In Coolify, `SOURCE_COMMIT` is a build argument fixed to the selected Git revision for **both**
resources, not a runtime environment variable. The commerce resource uses repository-root build
context and `commerce/Dockerfile`. Record the Git SHA and both image IDs before deployment.

## 2. Coolify resources, DNS, and TLS

Create a separate `mikluha-commerce` application and a separate Postgres resource. Do not reuse the
Refref database. Attach `book.mikluha-maklai.ru` and point its DNS A record at the VPS.

Required production environment:

```text
COMMERCE_ENVIRONMENT=PRODUCTION
COMMERCE_ORIGIN=https://book.mikluha-maklai.ru
SITE_ORIGIN=https://mikluha-maklai.ru
REFREF_API_BASE=https://api.refref.ru/v1-rc
REFREF_CHECKOUT_ORIGIN=https://checkout.refref.ru
DATABASE_URL=<commerce_runtime URL>
REFREF_BUSINESS_ID=<Mikluha Business UUID>
REFREF_BUSINESS_SLUG=<Mikluha Business slug>
REFREF_API_KEY=<secret>
UNISENDER_GO_API_KEY=<secret>
UNISENDER_GO_FROM_EMAIL=noreply@mikluha-maklai.ru
UNISENDER_GO_FROM_NAME=<reviewed sender name>
```

Do not set `SOURCE_COMMIT` at runtime. Use the literal Refref addresses above. Production accepts
only the normalized four fixed addresses shown here; any host, port, path, credential, query or
fragment mismatch refuses startup. Staging remains configurable. Keep the commerce application
disconnected from public traffic until its database has been bootstrapped and the site candidate
is live.

After certificates are issued, require HTTPS and check that plain HTTP redirects without ever
serving a booking form:

```bash
curl --fail --silent --show-error --location --proto '=https' \
  https://mikluha-maklai.ru/release.json
curl --fail --silent --show-error --location --proto '=https' \
  https://book.mikluha-maklai.ru/readyz
```

## 3. Database bootstrap: owner only

The owner runs migrations with the database-owner credential. The application credential must not
own the schema. Use a one-off container from the exact commerce image on the database network; do
not add the owner URL to the long-running service.

```bash
C=<exact-commerce-container>
IMG=$(docker inspect -f '{{.Image}}' "$C")
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$C")
test -n "$IMG" && test -n "$NET"

# /etc/mikluha-commerce/migration.env is root:root 0600 and contains only
# MIGRATION_DATABASE_URL=<owner URL>. Remove it after the bootstrap if it is not the approved
# owner-secret store.
docker run --rm --network "$NET" \
  --env-file /etc/mikluha-commerce/migration.env \
  "$IMG" node dist/bin/migrate.js
```

Using the same owner connection, create two distinct logins once. Supply passwords through the
owner's secret-handling procedure, never in shell history, Git, Linear, or logs:

```sql
CREATE ROLE commerce_runtime LOGIN IN ROLE commerce_app;
CREATE ROLE commerce_operator_login LOGIN IN ROLE commerce_operator;
```

Verify that neither login is a member of the other role. Put only the runtime URL in Coolify.
Create `/etc/mikluha-commerce/operator.env` as root-owned mode `0600`, containing only:

```text
OPERATOR_DATABASE_URL=postgres://commerce_operator_login:<secret>@<db-host>/<db>
```

The operator command always runs in a one-off container. It never uses `docker exec`, which would
expose the operator credential to the long-running service boundary:

```bash
sales() {
  docker run --rm --network "$NET" \
    --env-file /etc/mikluha-commerce/operator.env \
    "$IMG" node dist/bin/sales.js "$@"
}
sales status
```

Expected bootstrap result is `SALES=CLOSED`.

### Processing instruction: template is not a signature

Migration 0007 seeds `processing_instruction` with document
`pd-processing-instruction-refref-v1`, version `1.0`, processor `refref`, status `DRAFT`.
Only the template reference/hash is populated. `signed_at`, `effective_at`, `sha256` (the signed
file's hash) and `signed_document_ref` are NULL. Application/operator roles have SELECT only.
Nothing in this record opens sales or replaces tourist PD-consent evidence or the commercial hash.

Fill and verify the director's name, Refref OGRNIP/address/incident contacts and signing/effective
dates before signing the form in `commerce/legal/`. After both signatures, the owner stores the
signed file privately in Russia, calculates its SHA-256 and verifies the stored bytes. Only then,
through the owner credential and a separately authorized exact SQL packet, record `SIGNED` with
both dates, `sha256:<actual signed-file digest>` and an opaque private-store reference. Do not
copy the signed file or a credential-bearing URL into Git, Linear, Refref or public documents.
This runbook does not attest or perform that write.

The currently recorded real recovery proofs were for schema 6. Applying migration 0007 is an
owner-only production write; before future admission, obtain fresh logical and PITR recovery
evidence for schema 7 and its exact recovery image. Existing timers are not a proof of the new
schema, and this PR does not advance monitor admission.

## 4. Refref Business admission

Configure and independently read back the Mikluha production Business:

- verified origin: `https://book.mikluha-maklai.ru`;
- allowed destination paths: `/return` and `/orders/`;
- API-key scopes: `integrations:checkout` and `integrations:fulfillment` only;
- one Offer for every production tour that may receive a campaign, with `offerRef` equal to the
  tour slug; the departure slug is sent as `unitRef`;
- production merchant conformance passes against this Business and key.

Record identifiers and read-back results, not the API key.

## 5. Backups, PITR, and monitoring

Install the reviewed Refref-host integration only after its own PR is merged. Mikluha must have:

- hourly encrypted `pg_dump` plus WAL shipping/base backups for PITR;
- a distinct host folder for every Coolify storage/resource;
- a distinct S3 prefix that cannot overlap Refref;
- a distinct `mikluha-recovery` age private key and recipient (record only the public recipient or
  its public-half fingerprint in evidence);
- a successful isolated restore drill and recorded recovery point;
- monitor checks for HTTPS `/readyz`, backup freshness, WAL archive freshness, and the commerce
  aggregate signals below.

Never remove or convert a Coolify storage to rename it: Coolify deletes the storage's host folder.
Create new, unique paths instead.

The commerce container exposes only aggregate database signals:

```bash
docker exec "$C" node /app/commerce/dist/bin/monitor.js
```

The command emits `paidNotFulfilled` and `held` counts/oldest ages only. It exits `2` when either
is actionable and never emits order references, hold reasons, tokens, or customer data. The default
PAID grace is 300 seconds; a reviewed host setting may override it with
`MONITOR_PAID_GRACE_SECONDS`.

## 6. Bearer-document access-log gate

`/documents/<token>` grants access to passport-bearing contract data. Before any real order, use a
synthetic invalid token and prove that neither Traefik/Coolify nor application logs retain the
token or full path:

```bash
SYNTHETIC_TOKEN=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  "https://book.mikluha-maklai.ru/documents/$SYNTHETIC_TOKEN"

docker logs --since 2m coolify-proxy 2>&1 | grep -F "$SYNTHETIC_TOKEN"
docker logs --since 2m "$C" 2>&1 | grep -F "$SYNTHETIC_TOKEN"
```

Both searches must return no match. Do not test with a real document token. If the proxy's access
log records request paths, disable that access log for this traffic or install a reviewed redaction
mechanism before launch; application-level logging cannot repair a token already stored by the
proxy. Keep the exact proxy configuration and synthetic-test result as launch evidence.

## 7. Legal-release parity and readiness

Read both public endpoints and compare the immutable fields. Do not copy their output into a shell
command that might include secrets; these endpoints contain no secrets.

```bash
curl --fail --silent --show-error https://mikluha-maklai.ru/release.json
curl --fail --silent --show-error https://book.mikluha-maklai.ru/identity
curl --fail --silent --show-error https://book.mikluha-maklai.ru/readyz
```

Evidence must show the reviewed commit in both descriptors and exact equality of `termsRef`,
`termsHash`, `pdConsentRef`, and `pdConsentHash`. A later public legal-page deployment immediately
causes commerce readiness, reservation, and pay admission to fail until commerce from that same
commit is deployed.

## 8. Signed instruction and real contract content

Before opening sales, retain the signed PD-processing instruction from ООО «ООО МИКЛУХА МАКЛАЙ»
to ИП Гурьянов А.А. for Refref's processing of the receipt email. Store the signed artifact in the
approved Russian evidence store; do not commit it or attach it to Linear if it contains signatures
or personal data.

Replace every demo/placeholder commercial fact with owner-reviewed facts and build production with
`launchReady: true`. Confirm every OPEN departure has complete real contract data. The production
build and commerce catalog both fail closed, but those checks do not attest that supplied facts are
legally or commercially true—the owner does.

## 9. First real payment and ЕИС evidence

Only after sections 0–8 pass:

1. Record the exact site/commerce commit, image IDs, `/release.json`, `/identity`, `/readyz`, backup
   and monitor evidence.
2. Confirm `sales status` is CLOSED, then have the owner explicitly authorize opening.
3. `sales open --by <who> --reason "ART-47 first real payment"`.
4. Place one real, non-demo booking through the public site and pay through the production Alfa
   PROVIDER path. Never use the retired stand-in.
5. Verify Refref read-back proves exact amount and SUCCEEDED payment; verify Mikluha becomes
   FULFILLED, confirmation delivery evidence is accepted, and the order has `EIS_PENDING`.
6. Follow [`eis-manual-filing.md`](eis-manual-filing.md): print the packet only to the local
   operator terminal, submit manually in the ЕИС personal account, record the actual electronic
   voucher number against the reviewed material revision, then verify `EIS_SUBMITTED` and the
   stored contract/tourist facts against the filing.
7. Close ART-293 only with the real payment evidence **and** the completed ЕИС evidence step.
8. Close sales immediately if any money, fulfillment, email, document, monitoring, backup, or ЕИС
   evidence is inconsistent.

ART-47 is not complete merely because a deployment is healthy. The first real order must finish
the full payment-to-ЕИС evidence chain.
