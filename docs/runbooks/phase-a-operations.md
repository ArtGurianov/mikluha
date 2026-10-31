# Phase A project operations

CUSTODY_IMPACT: NO — undeployed portable source. Actual installations, credentials
and custody changes have separate resource-specific OWNER authority and private
operator receipts. [TOUR-67](https://app.plane.so/art-workspace/browse/TOUR-67/) and
[VPS-19](https://app.plane.so/art-workspace/browse/VPS-19/) track acceptance.

## Ownership

This repository owns `config/mikluha-phase-a/`, `scripts/mikluha-phase-a/` and
`tests/phase-a/`. Shared infrastructure keeps the VPS resource index/project link.
Credentials, private keys, actual installation descriptors, private receipts and
owner provenance stay outside Git, including encrypted copies/private repositories.
Coolify owns app env; matching recovery keys/credentials live in encrypted operator
custody. Use external `--candidate /private/operator/release.json` for real work;
never populate this tree with actual principals, key generations or private values.
No secret values or plaintext-secret hashes enter argv, logs, source or CI.

## Compose and source pins

Coolify Raw Compose Application reads its file from Git. Use this public repository
and `config/mikluha-phase-a/acceptance.compose.json`, raw mode enabled, auto-deploy/
previews/default-network attachment disabled, no domains. JSON is a YAML subset;
all credentials and installation identities use required env placeholders. A
Compose Service is a different controller and is not substituted. No private Git
access key is necessary.

The control Git commit differs from the image's baked `source_commit`. Images
remain digest-pinned to the qualified application release; this source move does
not rebuild/publish images. Qualify the pinned Git file/hash and normalized
rendered definition, then record `compose_source` in the private descriptor.
A registered slot or a ready label cannot bypass missing source evidence.

Coolify4.5.3 `oldRawParser` appends management labels even in raw mode. Compose
labels therefore use the sequence (`key=value`) form. A mapping plus appended
numeric entries is invalid and fails before container creation. Qualify the actual
controller transformation plus Docker Compose parsing, in addition to parsing the
original file; its injected management labels do not authorize public routing.


```sh
python3 scripts/mikluha-phase-a/prepare.py report
python3 scripts/mikluha-phase-a/prepare.py compose --stage database
python3 scripts/mikluha-phase-a/prepare.py validate-release --candidate /private/operator/release.json
python3 -m unittest discover -s tests/phase-a -v
```

These commands do not install/start anything. The portable default is NOT_READY.

## Isolation

Acceptance and clean working use separate DB volumes/networks/key generations.
Only gateway binds loopback TLS18443/18543; both origins use gateway443/SNI.
DB/public/admin networks are internal; only gateway joins ingress. Acceptance
worker alone holds S3 authority; decoder has no network/credentials. Working has
neither worker nor decoder. No public proxy/DNS change is implied.

App caps (MiB/CPU/PIDs): PostgreSQL512/.75/128, Commerce256/.25/48,
site512/.5/64, Admin API256/.25/48, UI128/.25/32, gateway128/.25/32,
worker256/.25/16, decoder512/.5/32. Backup768MiB/.5CPU plus AWS helper256MiB/.25CPU;
isolated restore512MiB/.5CPU. Recheck host headroom, one scope at a time, avoid
maxima overlapping restore. No hard PG disk quota or time-based log erasure claim.

## Cloud-only backup

Hourly encrypted logical dump to Cloud.ru; temporary ciphertext only in unit-managed
`/run` tmpfs. Persistent VPS files are status/lock only. No retained VPS archive,
holds, Mac collector/schedule, Git pins or scheduled Mac replica.

Dedicated private bucket/prefix; exact owner/ACL/policy read-back, versioning
Enabled, current expiry7d/noncurrent expiry7d. Producer has scoped Put/Get/
GetObjectVersion/List/config reads, no delete/config writes. Verifier is read/
version-list only. Native lifecycle owns cleanup; observed expiration is a separate
provider proof. Approximately14d plus async lag is not a hard erasure deadline.

Restore uses OWNER incident cutoff and newest complete pre-cutoff version-pinned
pair, provider timestamps, strict whole-second exclusion, metadata/bytes integrity
and no silent fallback from corruption. This is not independent authentication
against compromised producer/provider; retain the applicable risk decision outside
Git. Fixture success never qualifies real provider behavior.

## Manual isolated recovery

Age identity and historical Admin keys come separately from encrypted operator
custody. Local policy `~/.config/mikluha/local-docker.json` or
`MIKLUHA_LOCAL_DOCKER_POLICY` is owner-held0600, outside Git. It pins the approved
Desktop Unix socket/context/uid/daemon. No auto-enrollment; remote overrides,
changed sockets/daemon or policy symlinks fail before resource creation. This is
a manual-operation safety setting, not another scheduler or backup store.

```sh
python3 scripts/mikluha-phase-a/qualify-local.py --commerce-image '<qualified-digest>' --output /private/operator/local-qualification.json
python3 scripts/mikluha-phase-a/restore-local.py --candidate /private/operator/release.json --credentials /private/temporary/verifier.ini --scratch /private/temporary/scratch --identity /private/temporary/backup.agekey --incident-before '<owner-cutoff>' --admin-keys /private/temporary/admin-keys.json --authorized-disposable-restore
```

Structural-only is PARTIAL. Full restore checks schema journal/effective ACL/roles,
negative DB logins, audit attestation and TOTP decryption with recovered keys.
Local in-memory-provider image qualification is separate from actual cloud backup.
Rehearse before real entry, monthly and after schema/backup/key changes; retain only
private dated receipts, remove temporary plaintext/key access after use.

## Admission

A concrete OWNER install GO precedes DB-only then private runtime. Synthetic
acceptance uses a disposable DB. Create clean working independently; its OWN
automatic encrypted cloud dump/isolated restore precedes real Admin/legal entry.
Reconcile current account/session/media restrictions before restored services;
failure is NO-GO. Roll back only to qualified compatible SSR, otherwise maintenance;
never revive retired legacy/static. Minimum real OWNER accounts only in Phase A;
real third-party content, including drafts, is gated separately by Phase B.

Source CI, registry checks, provider checks, install, private browser acceptance,
new-DB restore, legal publication, domain and sales are separate facts. Keep sales
CLOSED and legal NOT PUBLISHED until their own accepted operations.
