# TOUR-63 · source and local transport evidence · 2026-10-30

CUSTODY_IMPACT: NO — code, contracts and disposable local fixtures only. No production DB migration,
Cloud.ru write/delete, credential enrollment, host installation, merge or sales activation occurred.
TOUR-63 remains In Progress. VPS-17 stage 2 is excluded from this acceptance.

## Executed scope

- Linux/PostgreSQL 16 full Commerce suite: **401 tests**, including the actual Admin HTTP server,
  password/TOTP/live-session permissions, migration/role boundaries, real decoder subprocess and
  Unix-socket RPC, image/pixel/frame/byte limits, canonical upload/rights/idempotency, bounded staging,
  publication, privacy quarantine/cleanup, retry/withdrawal serialization and public catalog resolution.
  Disposable Postgres was `tour63-postgres`, private local port 56463, never an existing app database.
- SDK transport test uses real HTTPS and verifies SigV4 signatures against a disposable S3 protocol
  fixture. It exercises conditional private PUT/replay, anonymous denial, real processed WebP bytes,
  MIME/hash/size/cache/CORS read-back, public ACL, versioning refusal and deletion/failure read-back.
  The TLS wrapper generates and removes a new private key/CA per run; no private test key is in Git.
- Site unit tests: **126 PASS**, including required-cover/gallery normalization after withdrawal.
  Root lint and Commerce typecheck PASS. Control Room typecheck, export/build and bundle secret
  check PASS; its existing bundle test PASS.
- SSR preview build PASS with `DEPLOY_ENV=staging` and an explicit 40-hex SOURCE_COMMIT. The baked
  snapshot has launchReady=false and zero real catalog items: it is not a production release. The
  first build without the staging flag correctly refused the demo snapshot; the next run without
  SOURCE_COMMIT correctly refused an invalid release identity. Neither guard was disabled.
- Separate headless Chrome UI fixture: media tab, OWNER publish, confirmed revoke, pending-deletion
  copy, desktop/mobile and no page errors PASS. This fixture stubs `/api` for UI behavior only; it is
  not a browser attestation of real authentication, S3 or installed Admin. Authentication is exercised
  separately over the real HTTP API above. Screenshots were inspected; mobile field width corrected.
- Built the distinct worker and decoder targets. With the actual resource envelope, a credential-free
  decoder served a real 8px synthetic PNG over a Unix socket to a worker image with **no IP network**.
  The worker generated an offline four-key qualification plan and hashes without S3 credentials.
  Decoder inspection: network=none, readonly=true, RAM=536870912, nanoCPUs=500000000, pids=32,
  cap_drop=[ALL]; direct egress attempt was blocked. Worker: 256 MiB, 0.25 CPU, 16 PIDs. Shared socket
  mounted read-only by worker. These are working-tree conformance builds, not deployed images or an
  independent exact-HEAD image attestation. The default Docker target still serves Commerce.

The full Linux suite was executed with current source/test/migration/script directories mounted
read-only over the test runner image. Example (inside a disposable local Docker environment):

```sh
docker build -f commerce/Dockerfile --target media-test \
  --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" -t tour63-media-test .
# Point TEST_DATABASE_URL only at an owned disposable PostgreSQL 16 instance.
# media-test's CMD generates ephemeral TLS and invokes the full test suite.
```

Old migrations 0001–0017 remain byte-identical; 0018 alone is added. Run the immutable history checker
against the committed PR base/head; it audits intermediate commits, not just the final directory.

## Explicitly not qualified

Actual Cloud.ru/IAM/bucket-policy/ACL/CORS/versioning behavior, real account credentials, provider
read-back/deletion, installed Control Room → worker → S3 → real SSR pages, new database off-host
backup/isolated restore, hosted GitHub CI, deployment and sales GO are **NOT_RUN / NOT_ATTESTED**.
The protocol fixture cannot substitute for Cloud.ru acceptance. No legacy credentials or media are
reused. The runbook provides an offline exact-key provider plan and a guarded synthetic write/delete
command; provider execution requires separately scoped owner authorization for those four keys.

No VPS-17 receipt is needed to finish stage 1. TOUR-63 must not be closed before the independent
stage-1 provider/installation/recovery evidence above exists.
