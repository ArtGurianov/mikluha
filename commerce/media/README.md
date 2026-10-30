# TOUR-63 · direct S3 image contract

CUSTODY_IMPACT: YES for the separately authorized Cloud.ru qualification: new dedicated bucket,
policy/CORS, scoped service account and temporary access key (revoked after qualification). See the
dated provider receipt. No deployed database or VPS resource was changed. Sales remain CLOSED.
Host installation is a separate operation: record changed resources/authorities and link VPS-15. Apply the Mikluha clean-slate
exception in AGENTS.md; do not report unrelated whole-VPS drift as PASS.

## API / editorial integration (TOUR-64)

The existing same-origin HttpOnly + password/TOTP session guards all `/api/media` routes.
There is no browser S3 writer, presigned PUT, arbitrary URL fetch or Admin S3 credential.

- `POST /api/media`: `{id, data, alt, credit, rightsBasis, rightsReference, rightsConfirmed:true}`.
  `id` is a client-generated UUID, reused for the exact same retry. `data` is canonical base64,
  not a data URI. JPEG/PNG/WebP only, at most 8 MiB. `rightsBasis` is `OWNED` or `CONSENT`;
  `rightsReference` identifies private source/copyright/recognizable-person consent evidence.
  The checkbox is an accountable declaration, not automated legal verification. OWNER/EDITOR.
- `GET /api/media`: latest 100 assets and private editorial metadata; no source bytes/keys.
  OWNER/EDITOR. Published variant URLs appear only in PUBLISHED state.
- `POST /api/media/<id>/publish`, `{}`: live OWNER only, READY → PUBLISH_REQUESTED.
- `POST /api/media/<id>/revoke`, `{}`: live OWNER only, immediately stops public projection
  eligibility and queues deletion. Idempotent; cannot re-publish a withdrawn ID.
- Commands return **202 acceptance**, never a claim that processing/publication/deletion finished.
  Re-fetch status. Network ambiguity is retried with the same ID/action. `MEDIA_BUSY` means a
  bounded lock wait expired; retry. There are two simultaneous upload readers per API process,
  a 12 MiB JSON/20 second body bound, and at most 32 staged originals in the database.

Store `{image:"media:<UUID>", alt:"..."}` in an editorial image field. Commerce resolves only
PUBLISHED variants in the same repeatable-read snapshot as the catalog. Canonical media alt
comes from the media record. References do not leak private paths or rights evidence. Missing or
withdrawn required images resolve to the tracked local neutral `image-unavailable.svg`, so one
withdrawal cannot break normalization of every tour. Text fields are never rewritten. The SSR
site already uses native `<img>`; no Next optimizer, browser credential or HTML rebuild is needed.
The processed URL is a fixed S3 HTTPS URL. Keep `MEDIA_DELIVERY=direct` for stage 1; the historical
CDN prefix mode does not qualify VPS-17. Stage 2 is explicitly outside TOUR-63 acceptance.

## Worker / storage / limits

Build `commerce/Dockerfile --target media-worker` from the repository root with exact SOURCE_COMMIT.
Start `dist/bin/media-worker.js`, using `compose.example.yml` as the resource envelope.
Build the separate `media-decoder` target too. It has no credentials and `network_mode: none`;
its only channel is a Unix socket in the dedicated socket volume, mounted read-only by the worker.
The worker image has no Python/Pillow. Dropping child environment variables alone would not protect
parent credentials from a compromised parser running under the same UID in the same container. Attach only
to the relevant private DB network; expose no ports or Docker socket. One replica / one job at a
time. The media-only login is a member of `media_worker` and no application/Admin/operator role;
it is neither owner nor migration login. The process refuses other applications' credentials.

The worker environment contains only its dedicated `MEDIA_DATABASE_URL`, `MEDIA_S3_ENDPOINT`
(shared API origin, e.g. `https://s3.cloud.ru`), `MEDIA_S3_BUCKET`, `MEDIA_S3_REGION`,
`MEDIA_S3_PUBLIC_ORIGIN` (verified bucket global/domain HTTPS origin),
`MEDIA_S3_PRINCIPAL_ARN` (the dedicated Cloud.ru service account ARN),
`MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`. Secrets are enrolled separately through the
approved host/Coolify secret authority, never committed. Admin must not receive these values.
No AWS credential chain is used. Region and bucket must be verified with the actual account.
Cloud.ru public URLs use the separately enrolled `MEDIA_S3_PUBLIC_ORIGIN` plus `/media/v1/...`,
because browser CORS uses the bucket's public host. The local API bucket name and its global/domain
name can differ; deriving the public hostname from the local name is refused. See the provider
[public-access contract](https://cloud.ru/docs/s3e/ug/topics/guides__public-access-for-bucket). Only the disposable loopback HTTPS fixture uses public path style.

Use a newly qualified private-by-default bucket, **versioning never enabled** (even Suspended is
refused), BucketOwnerEnforced ownership and no public ACL grants. Cloud.ru Evolution returns
NotImplemented for PutObjectAcl; the worker never calls it or sends an ACL header. Configure the
reviewed policy from `publicVariantPolicy(bucket, principalArn)` in `src/media/policy.ts`:

- Anonymous GetObject only on the three `media/v1/*/*/{480,960,1600}.webp` names; never original,
  listing, writes or the whole bucket.
- The enrolled principal has GetObject/PutObject/DeleteObject on those names and `original`.
- Explicit Deny outside those four key patterns and for bucket configuration mutations. Restrict
  the account's provider roles to this dedicated bucket: editor, viewer and viewer-acl. Never use
  s3e.admin, tenant.edit or Project Administrator: those bypass bucket-policy restrictions.

The worker reads versioning, policy, ACL and ownership controls before processing. Policy read-back
requires the exact anonymous/worker grants and mandatory fences (extra Deny rules are allowed).
Canonical empty provider fields are accepted, nonempty alternate selectors/conditions are not.
Provider role propagation can lag console updates: prove positive private read, signed absence,
negative out-of-prefix write, bucket mutation denial and unrelated-bucket denial before enrollment.
Only the operator configures policy/CORS/versioning, never the worker. No replication or unaccounted
retained versions are admitted. Legacy Sveltia and backup credentials are not worker credentials.
The runtime does not list objects. Cloud.ru's viewer role can list this dedicated bucket; it grants
no unrelated bucket access, and listing is not published anonymously. Verify that privilege when
reviewing actual provider roles rather than claiming it is absent.

Configure browser GET/HEAD CORS for `https://mikluha-maklai.ru` (and separately approved staging
origins); no credentialed browser requests. Public GET must return ACAO matching that origin or
`*`, Content-Type `image/webp`, and `Cache-Control: public, max-age=60, must-revalidate`. No CDN is
used. WebP objects are first uploaded only after OWNER admission; the narrow bucket policy makes
those paths public. Anonymous full-byte/hash/MIME/size/CORS/cache read-back is required before
PUBLISHED. An unconfirmed private-original admission
quarantines the record and immediately queues deletion of all four known keys; it must not leave a
possibly public original waiting for five admission retries. PRIVACY_UNCONFIRMED is visible in Admin. There may be partial public variants while publication is
pending; they were explicitly authorized, but are not yet discoverable through the public catalog.

Keys: `media/v1/<asset UUID>/<original SHA256>/{original,480.webp,960.webp,1600.webp}`. Conditional
PUT prevents overwrites, including retries after a crash. Bytes are immutable, not browser retention.
Do not silently change the v1 encoder/profile for pending records: a future transform version gets a
new namespace and asset ID. The source remains private. READY stores variant hashes/dimensions/URLs in the database, but
processed bytes do not yet exist in S3. On publication the worker privately re-reads/verifies the
original and regenerates the pinned profile, refusing changed hashes/dimensions before writing.
Full signed read-back and anonymous 403/404 are checked after each original write. Public variant
writes also require signed hash and anonymous full-byte verification, including replay.

The decoder accepts one frame, at most 16,000,000 pixels and 8192 per side, applies EXIF orientation,
then copies pixels to fresh images before emitting WebP at widths 480/960/1600 without upscaling.
EXIF/GPS/XMP/ICC do not propagate. Linux subprocess limits: 384 MiB address space, 8 CPU seconds,
15 seconds wall time, 16 MiB per output file, 32 open files, bounded stdout and no inherited secrets.
Decoder container: 512 MiB RAM, 0.5 CPU, 32 PIDs, 64 MiB temporary filesystem, no IP network, read-only root, no capabilities.
Worker container: 256 MiB RAM, 0.25 CPU, 16 PIDs, read-only root, no capabilities.
The socket volume contains no image, credential or recoverable data; recreate it at recovery.
The decoder accepts one 8 MiB stream at a time and sends at most 34 MiB of bounded variant JSON;
the worker independently validates dimensions/profile/size/header and calculates each hash.
At the extreme input limits, resource exhaustion safely rejects an image; those bounds do not
promise every such image can be processed. Do not disable limits to make a fixture pass on macOS.

Each storage call has a 10 second deadline, no SDK automatic retries. A job holds its DB row lock
through I/O, and OWNER requests serialize with it (API gives up waiting after 5 seconds). On
unconfirmed I/O it remains pending, retries at most five times one minute apart and then needs an
operator. Other assets continue. Inspect `admin_media.attempts/last_error` and `media_event`; never
mark pending deletion complete manually. To retry after repairing storage, an authorized DB owner
may reset attempts and next_attempt_at for the **specific still-pending** asset, leaving its state,
rights and events intact. Do not reset REVOKED or change it to READY/PUBLISHED.

## Withdrawal, backups and recovery

An OWNER revoke first removes DB public eligibility. The worker deletes the three fixed variants
and original; it requires authenticated 404 and anonymous 403/404 for each key before REVOKED.
403/network timeout/5xx on the signed check is **not** deletion proof. A crash/partial write/delete
retries the same four keys; no bucket listing or arbitrary prefix deletion is performed. It cannot
publish a row after a committed revoke. Existing/in-flight downloads and browser copies cannot be
recalled; normally cached copies may survive for up to 60 seconds. Legal disclosures must say so.

`media_asset` (including transient original bytea and private rights references), `media_event`,
new media-only DB/S3 credentials, the two containers and their socket volume, and bucket policy/CORS are changed resources at installation.
Include metadata/staging in the new DB's encrypted off-host logical backup and prove one isolated
restore **before real content entry**. This does not replace the separate pre-sales gates. Temporary
files disappear after each decoder run; NGINX upload buffering is disabled on this endpoint.

REVOKED means confirmed removal from the current live unversioned S3 origin, not physical erasure
of historical encrypted DB backups or copies already delivered. Apply the approved backup retention
policy, preserve the minimum rights/audit evidence separately, and reconcile **all later withdrawal
records** before starting a worker/public site from an old backup. Keep restored data isolated and
the worker stopped if the latest withdrawal ledger cannot be independently established. No automatic
restoration/re-publication of deleted objects or demo/legacy media is authorized.

## Evidence boundaries / acceptance

Local Linux tests exercise the actual Pillow process and PostgreSQL capabilities, authenticated
HTTP API, queue/lifecycle, projection withdrawal and HTTPS + verified SigV4 SDK transport against a
disposable protocol fixture. That fixture is not Cloud.ru. The test wrapper generates a fresh disposable TLS key/CA per run and removes it afterwards;
no test private key is committed. Do not trust its CA outside that test process.

Provider qualification remains mandatory before TOUR-63 Done: actual scoped Cloud.ru credentials,
private-original denial (including policy read-back), conditional writes/replay, WebP/hash/MIME/size,
HTTPS certificate, bucket CORS/cache, partial failure and confirmed deletion. Then prove real SSR
pages/Control Room against the installed worker and qualify the changed DB backup/restore. Do not
infer installation, provider PASS, recovery PASS or sales GO from unit tests, CI or a draft PR.

An offline provider-test plan is available in the media image (endpoint/local bucket/public origin/principal ARN env needed):

```sh
node dist/bin/media-qualification.js plan > /tmp/tour63-provider-plan.json
```

It prints four exact synthetic keys and processed hashes, without provider/network I/O (the local Unix-socket decoder must be running). Review the plan and
obtain owner GO for those writes **and their deletion**. Only then enroll the narrowly scoped
credential and run, from the worker image with that plan and the decoder socket mounted read-only:

```sh
MEDIA_QUALIFICATION_PLAN=/run/tour63-provider-plan.json \
  node dist/bin/media-qualification.js execute --owner-authorized-write-delete
```

The flag records execution intent; it does not grant approval by itself. This tool writes no DB,
uses no real image and cleans only the four approved keys, including partial failures. An
UNCONFIRMED cleanup is an outstanding deletion, not success. Its report keeps IAM policy read-back,
Admin/SSR installation and backup/restore NOT_RUN; these need their own evidence.
