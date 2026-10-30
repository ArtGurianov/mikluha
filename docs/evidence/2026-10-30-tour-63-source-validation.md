# TOUR-63 · source and local transport evidence · 2026-10-30

CUSTODY_IMPACT: YES — new Cloud.ru synthetic-qualification bucket, policy/CORS and scoped temporary
account/key under owner GO. Resource authority/post-state is recorded below and in the provider
receipt; see [VPS-15](https://app.plane.so/art-workspace/browse/VPS-15/). No production DB migration,
VPS installation, merge or sales activation occurred.
TOUR-63 remains In Progress. VPS-17 stage 2 is excluded from this acceptance.

## Executed scope

- Linux/PostgreSQL 16 full Commerce suite: **404 tests**, including the actual Admin HTTP server,
  password/TOTP/live-session permissions, migration/role boundaries, real decoder subprocess and
  Unix-socket RPC, image/pixel/frame/byte limits, canonical upload/rights/idempotency, bounded staging,
  publication, privacy quarantine/cleanup, retry/withdrawal serialization and public catalog resolution.
  Disposable Postgres was `tour63-postgres`, private local port 56463, never an existing app database.
- SDK transport test uses real HTTPS and verifies SigV4 signatures against a disposable S3 protocol
  fixture. It exercises conditional private PUT/replay, anonymous denial, real processed WebP bytes,
  MIME/hash/size/cache/CORS read-back, narrow publication policy, versioning refusal and deletion/failure read-back.
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

Installed Control Room → worker → S3 → real SSR pages, new production database off-host backup /
isolated restore, deployment and sales GO are **NOT_RUN / NOT_ATTESTED**. Local protocol/UI fixtures
do not substitute for installed acceptance. The provider adapter has now been exercised against real
Cloud.ru separately, as described below; no legacy credentials or real photos were reused.

No VPS-17 receipt is needed to finish stage 1. TOUR-63 must not be closed before the independent
stage-1 provider/installation/recovery evidence above exists.

## Provider discovery / hosted check follow-up

Read-only `aws s3api` discovery found local bucket `mikluha` via `https://s3.cloud.ru`;
`head-bucket` reported ru-central-1. Default and explicitly path-style requests for ACL, CORS and
versioning returned AccessDenied; policy read-back did too. At that initial discovery point no object write/delete or bucket config
change had been attempted; the subsequently authorized qualification is recorded below. A CLI listing is not privacy or versioning proof. A narrowly scoped readable
bucket configuration and separately enrolled worker credential remain required.

The public Cloud.ru global/domain name is enrolled separately as MEDIA_S3_PUBLIC_ORIGIN; it is not
derived from the local bucket name. Local tests cover a deliberately different global name.

Hosted Actions started on the first PR head (so the historical billing block is not assumed current).
The exact-image probe correctly refused its old pinned schema 17 baseline after the real head
advanced to 18; its reviewed baseline is now 18, and the additive forward fixture is 19. Runtime
media-view privileges are checked too. Final hosted result belongs to the exact PR head/checks.

## Authorized Cloud.ru qualification follow-up

After owner login in managed Chrome and explicit GO, created a dedicated empty bucket
`mikluha-media-v1` (global domain `mikluha-media-art-v1.s3.cloud.ru`), quota 1 GB, versioning disabled,
BucketOwnerEnforced, no public ACL grants, explicit WebP-only bucket policy and GET/HEAD CORS for
`https://mikluha-maklai.ru`. The old bucket `mikluha` was read only and left unchanged. The console
recommended SINGLE storage during STANDARD upload impairment, so only synthetic data was admitted;
real-content durability and production enrollment remain a separate review.

Evolution returned **501 NotImplemented for PutObjectAcl**. The adapter was corrected: READY stores
only variant metadata plus a private original; OWNER publication re-reads/hashes the original,
regenerates the fixed profile, then conditionally uploads the three policy-admitted WebP names.
No ACL mutation or ACL header is used. Added tests cover absent-before-publication WebP, required
policy grants/fences and actual EXIF GPS/orientation, ICC/XMP stripping, not just a metadata marker.

The dedicated service account had bucket-scoped editor/viewer/viewer-acl, no tenant/admin role.
Read-back and negative tests prove private signed read; anonymous original 403; out-of-prefix PUT,
bucket-policy mutation and unrelated old-bucket access denied. A transient read denial after role
changes disappeared before the final successful runs; successful console assignment alone was not
accepted as proof. The policy fence was temporarily removed during diagnosis: one extra synthetic
probe was created, then deleted with authenticated NoSuchKey verified, and the fence was restored
and its negative PUT rechecked.

The actual worker SDK/isolated decoder completed **provider transport PASS / deletion PASS** with
the reviewed policy/fences: conditional replay without overwrite, three real WebP profiles,
full signed/anonymous SHA/size/MIME/CORS/cache read-back, signed 404 plus anonymous denial after each
delete. Final ListObjectsV2 was empty. Four approved keys were reused for retries; no broad deletion
was used. The raw CLI report keeps external IAM role audit NOT_RUN because that is a separate
console/read-back receipt, captured here instead. Exact configuration, source hashes and results:
[provider receipt](2026-10-30-tour-63-cloudru-provider.json).

Resource authority is the owner's Cloud.ru project/console (bucket/account identifiers in receipt),
not Coolify or the shared VPS. No persistent worker credential was enrolled. The one-day test key
was deleted; console read-back shows no keys and signed configuration access is now denied. Its
private local capture/transfer material was removed and the qualification account disabled. The empty bucket/policy/CORS and disabled qualification account remain for
operator inventory. Reuse in production requires dedicated credential enrollment and revalidation,
not recovery of the disposed test key. No whole-host custody or production recovery PASS is claimed.

Hosted CI on preceding 6180a70 was 5/5 SUCCESS (run 41036529536). That head still used unsupported
ACL publication and does **not** qualify this follow-up. Current-head checks are recorded in PR #61.
