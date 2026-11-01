# Phase A project operations

Новые локальные даты используют **Asia/Krasnoyarsk**: [OWNER 2026-11-01](../decisions/2026-11-01-local-calendar-and-cdn.md).
Working обновлён до schema20; две точные review.3 редакции опубликованы в приватном
Commerce как version1/effectiveOn2026-11-01 после actual Cloud.ru backup/restore.
См. [свидетельство исполнения](../evidence/2026-11-01-working-schema20-legal-publication.json).
Сохранённый acceptance остаётся на schema19. Хост намеренно Etc/UTC;
действующие UTC backup timers не переносить. Приватная публикация не открывает домен.

CUSTODY_IMPACT: YES — the scoped backup notification add-on changes host files
and credential consumers when installed. Actual installations, credentials
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

### Retained acceptance and schema20

The stopped schema19 acceptance contains synthetic legal publications. Migration0020
refuses any existing `legal_publication` history with
`LEGAL_CALENDAR_HISTORY_REQUIRES_REVIEW`; do not restart that retained database
with schema20 images or remove/bypass the guard. Its old DB, evidence and compatible
schema19 source remain historical recovery material.

For new schema20 acceptance, provision a separate disposable database/volume from
the qualified schema20 release, without importing old synthetic legal history.
Provisioning, any new keys and eventual deletion of retained resources require their
specific OWNER authority; this runbook grants none. Do not clear or reuse the old volume.

### Domain cutover checklist — separate OWNER GO

Private publication on2026-11-01 is not evidence that a visitor can access the policy.
Before admitting the public SSR site/data-collection flows:

- Confirm the current approved Commerce versions, full body hashes and effective
  dates in Asia/Krasnoyarsk; match the actual intended data flows to those versions.
- Prepare the target HTTPS ingress so `/privacy-policy/` and `/cookies/` are
  available from the start. Open and verify those public legal URLs before
  admitting the remaining public site/data-collection flows, within the separately
  authorized cutover. Never plan to publish the pages after opening collection.
- From an external network, without Admin login, tunnel, VPN requirement or a
  cookie-consent wall, require HTTPS200 and the full current texts, visible version,
  effective date, body hash and working policy links on collection pages/footer.
  A private Host/SNI probe is preparation, not this public-access receipt.
- Read back the public pages against Commerce authority: no unavailable placeholder,
  old YAML/static fallback, stale revision or private approval note. If the checks
  fail, do not admit collection; keep the remaining site in maintenance and repair
  policy access. Record the domain/TLS/version/hash/time evidence separately.
- Sales, Phase B and CDN admission retain their own gates. The other five legal
  routes may remain unpublished for a sales-CLOSED release; they must be separately
  reviewed, OWNER-approved and published before sales.

This makes public policy access an explicit cutover condition under
[152-FZ article18.1 part2](https://www.consultant.ru/document/cons_doc_LAW_61801/eeeebe22bf738fd65bb66b95cc278911ae2525ee/).
Maintenance or a closed domain is not proof of zero personal-data processing:
Admin identities and any HTTP/IP logs remain subject to the actual-flow review.
This checklist is not an assertion of complete legal compliance or cutover execution.

### Later privacy revisions

The current privacy publication is version1; the next changed privacy text must be
version2, then subsequent versions, through the same OWNER-only draft/approval/
`publish-legal` procedure. Read the actual current revision/version before publishing;
never overwrite version1 or silently replace the approved review.3 source bodies.
Record the new text/document hashes and the actual local effective date.

CDN/TOUR-97 requires a newly approved privacy revision before changing direct Cloud.ru
delivery to `assets.refref.ru`. Phase B/TOUR-94 requires an actual-flow privacy review
and publication of any required new revision before third-party content, including
drafts, is entered. Neither a privacy revision nor this checklist alone opens Phase B.
See the [legal source and pre-sales boundaries](../legal/2026-10-30-ssr-admin/README.md).

## Backup failures and real OWNER recovery gate

The optional project-owned `notify.py` and alert unit send fixed operational facts
through the existing operator Telebuzzy channel. Install only the intended scope's
OnFailure drop-ins; the working files are in `systemd/*.service.d/notify.conf`.
Enroll its root0600 `notify.credentials` outside Git as JSON with only `apiKey`,
with matching encrypted project custody. Never include customer data, exception
text, DB dumps, logs, URLs from configuration, or credentials in notification fields.
Unknown/refused delivery fails closed; only provider acceptance acknowledges an
incident locally. A2xx response is not independent confirmation of Telegram receipt.
The capture and freshness handlers share one episode anchored to the last
successful backup, not each failed attempt timestamp. Send on the first failure,
then at most one reminder every6hours; a new successful capture resets the episode
so a later new outage alerts immediately. Refused/unknown sends do not advance
acknowledgment or reminder sequence. Existing legacy acknowledgments without an
episode migrate on the next actual failure. Inspect their
own failed units if the notification provider is unavailable.

Qualification uses a bounded runtime-only inaccessible-credential override on the
selected capture service, with its timer paused and restored. The actual capture
must fail before dump/upload and invoke OnFailure. Remove the override, daemon
reload, recover normal encrypted capture/freshness and verify original timer state.
No valid credential, other project unit or live data is changed for this probe.

Independently compare external recovery keys with Coolify and actual Admin runtime
bytes without printing values or hashes. After the sole real OWNER confirms2FA,
perform a new actual Cloud.ru capture and isolated restore using external keys.
Require at least one decrypted TOTP row, attested audit, FORGED0 and UNVERIFIABLE0.
The earlier empty working restore remains valid structural evidence, but is not
this populated-crypto proof. No third-party content, legal publication, domain or
sales activation follows automatically from OWNER enrollment or a successful test.
