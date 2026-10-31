# Secrets inventory and rotation/recovery runbook (source-only)

Status: **SOURCE-ONLY INVENTORY AND RUNBOOK**, 2026-10-31. TOUR-50 / ART-325, executor Agent D
(security/runbook source). This document records *where* each secret lives, *who* consumes it, and
*how* it would be rotated and recovered. It **contains no secret values**, performs **no rotation**,
and requires **no access to production secrets**. Any real host/credential state change is handed to
[VPS-15](https://app.plane.so/art-workspace/browse/VPS-15/) with `CUSTODY_IMPACT: YES`, explicit
owner authorization for the specific operation, and a post-change custody/read-back receipt. Agent D
is the source/runbook owner, **not a second credential writer** (SSR/Admin source = Agent C, native
payment source = Agent A).

Governing contracts: the shared-host custody boundary in
[AGENTS.md — Infrastructure custody](../../AGENTS.md), the
[clean-slate owner decision](../../docs/decisions/2026-10-30-clean-slate-owner-decision.md),
[`adman-vps-infrastructure` AGENTS.md](https://github.com/ArtGurianov/adman-vps-infrastructure/blob/main/AGENTS.md),
and the pattern reference `refref/ops/runbooks/secret-rotation.md`. Coordinate shared-host records
with [ART-343](https://app.plane.so/art-workspace/browse/VPS-1/) /
[ART-346](https://app.plane.so/art-workspace/browse/VPS-4/).

## 0. Rules that bind every row

- No plaintext secret, real bank payload, PD package, signed document or bearer token in Git, PRs,
  CI logs, Plane/Linear or chat. Inventory records **reference** a secret (name, custodian, storage
  path, public-half fingerprint), never its value.
- **Authoritative custodian** is exactly one of: **Coolify** (application env for the Mikluha
  commerce/site resources), **host/SOPS** (host-owned secrets SOPS-encrypted in the private infra Git
  repo; the age *decrypt* identity lives on the owner Mac, **never** on VPS/GitHub/CI), or **offsite
  owner escrow** (production backup/recovery private keys, off-VPS).
- **One custodian per secret (custodian-resolution rule, P2).** Every secret has exactly **one**
  store of record, picked by its actual consumer: a secret consumed by a deployed Mikluha service →
  **Coolify** env of that service; a host-level automation/backup secret → **host/SOPS**; a
  backup/recovery private key → **offsite owner escrow**; a CI-only credential → the **CI secret
  store**. Where a cell below shows a transient file (e.g. a root-`0600` bootstrap file), that file is
  a *transient materialisation* for a one-off step, not a second custodian: the store of record is
  named first and the file is removed after use. A secret is never listed as owned by two stores at
  once.
- No automatic/live rotation. "Owner-only action" marks every step that only the owner may perform.
- Clean-slate limits: retain existing Refref keys until legacy drain and **do not rotate now**; do
  **not** revoke the shared Alfa merchant/principal or any shared/backup/new-stack credential by
  name; retire Sveltia-only writer credentials **only after** their exact consumer scope is
  identified (TOUR-66). New deletions/rotations/host changes each need a separate explicit owner GO.

## 1. Inventory — native acquiring and fiscal (TOUR-50 primary scope)

These are **future** credentials: the native Alfa acquiring path (TOUR-77) and the Ferma/OFD fiscal
chain are **not yet provisioned or referenced in source**. The rows below are the custody plan to
apply *when the owner provisions them*, not evidence that they exist. No value is requested or stored.

| Secret (class) | Custodian | Consumers (planned) | Scope | Storage path (no value) | Generation / blast radius | Owner-only action | Revoke/rotation overlap | PITR / escrow dependency | Fallback | Verify / read-back |
|---|---|---|---|---|---|---|---|---|---|---|
| Alfa merchant API/gateway credential (native card + SBP, one merchant) | Coolify (Mikluha commerce env) | native payment operations (TOUR-77), refunds | create/confirm/refund operations for the Mikluha merchant only | Coolify env var on `mikluha-commerce`; name recorded here, value never | issued in the Alfa cabinet by the owner; blast radius = all native money operations | yes — issue/rotate/revoke in the Alfa cabinet | **provider-capability-dependent — see §3.1**; the exact procedure cannot be fixed until Alfa's capability (simultaneous keys vs. immediate replacement vs. key-tied-to-connection) is confirmed (TOUR-83) | none in DB; operations reference provider IDs, not the key | owner confirms in cabinet + one proven read-back operation; record provider/connection IDs only; UNKNOWN-op read-back must survive the change (§3.1) |
| SBP-specific credential (if distinct from the card merchant) | Coolify | native SBP operations | SBP init/refund | Coolify env on `mikluha-commerce` | Alfa/SBP cabinet | yes | same provider-capability-dependent rule as the card credential (§3.1); if distinct, confirm its own capability | n/a | n/a | proven SBP read-back on a test operation |
| Ferma / OFD.ru fiscal credential | **Coolify** if the commerce service consumes it directly; **host/SOPS** only if it is a host-level automation secret — pick one per actual consumer, never both | fiscal document issue/read-back via the Alfa→Ferma chain | issue/correct/read fiscal documents for the Mikluha owner profile | the chosen custodian only (name only) | OFD.ru cabinet | yes | provider-capability-dependent (§3.1); a fiscal key gap blocks closing receipts | fiscal outbox retries are idempotent on the provider ID, not the key | owner confirms the real Alfa→Ferma chain for card/SBP/first-instalment/top-up/refund before any live receipt (fiscal §2, §8) |

**Shared-resource guard:** the Alfa merchant/principal is a *shared* banking principal — it is not a
Mikluha-exclusive deletion/rotation target (clean-slate). Any operation on it needs its own explicit
owner authorization and goes through VPS-15, not this runbook.

## 2. Inventory — existing secrets in the current source

Names below are the env references actually present in source (`commerce/src/config.ts`,
`commerce/src/admin/api.ts` `FOREIGN_ENVIRONMENT`, `commerce/src/bin/media-worker.ts`,
`commerce/runbooks/production-launch.md`). Values are never recorded.

### 2.1 PostgreSQL roles and logins

Roles (migration 0011 / 0017 / 0019): `commerce_app`, `commerce_operator`, `admin_app`,
`admin_publisher`, `admin_operator`, `media_worker`. Logins are created once by the owner on the
owner connection (production-launch §3) and must stay mutually non-membered and least-privileged.

| Login (env) | Custodian | Consumer | Scope | Storage path | Owner-only action | Rotation overlap | PITR / restore impact | Verify |
|---|---|---|---|---|---|---|---|---|
| migration owner — `MIGRATION_DATABASE_URL` | **offsite owner store** (store of record); transiently materialised into a root-`0600` file for bootstrap only | one-off migrate container | owns schema, runs attested migrations | `/etc/mikluha-commerce/migration.env` (root `0600`), removed after bootstrap unless it is the approved owner store | yes | rotate in DB; no running service holds it, so no overlap problem | password rotation must be re-applied on the restored copy — a restore reintroduces the pre-rotation password (key/DB divergence, §4) | login works for migrate, never present in the runtime/admin/media env |
| runtime — `DATABASE_URL` (`commerce_runtime` in `commerce_app`) | Coolify | long-running commerce service | app DML under `commerce_app` grants | Coolify env on `mikluha-commerce` | — | rotate DB password + Coolify env together; brief restart, not a bank-style no-overlap case | restore reintroduces the old password until re-rotated | `pg` connects; it is **absent** from admin/media processes (`assertAdminEnvironment`, `MEDIA_FOREIGN_CREDENTIAL`) |
| operator — `OPERATOR_DATABASE_URL` (`commerce_operator_login` in `commerce_operator`) | root-`0600` host file | one-off `sales` / `eis` containers | sales switch + EIS filing | `/etc/mikluha-commerce/operator.env` (root `0600`) | yes | rotate in DB + rewrite the env file | restore reintroduces old password | runs only in a one-off container, never `docker exec` into the service |
| admin app / publish / operator — `ADMIN_DATABASE_URL`, `ADMIN_PUBLISH_DATABASE_URL`, `ADMIN_OPERATOR_DATABASE_URL` | **Coolify (Admin resource)** | Control Room / Admin API | isolated admin capabilities; must not carry commerce/media/operator creds | Admin resource env | — | rotate per login with its service restart | restore reintroduces old passwords | `ADMIN_LOGIN_NOT_ISOLATED` / `FOREIGN_ENVIRONMENT` guards hold |
| media — `MEDIA_DATABASE_URL` (`media_worker`) | Coolify (media worker) | media worker only | media rows only; isolated login | media worker env | — | rotate + restart media worker | restore reintroduces old password | `MEDIA_LOGIN_NOT_ISOLATED` guard holds |

### 2.2 Application secrets, signing/service tokens

| Secret (env) | Custodian | Consumer | Scope | Owner-only | Rotation overlap | Restore impact | Verify |
|---|---|---|---|---|---|---|---|
| `NOTISEND_API_KEY` (+ non-secret `NOTISEND_FROM_EMAIL/NAME/REPLY_TO`) | Coolify | confirmation email | send transactional mail | — | Notisend has **no idempotency key** — never resend an unknown-outcome message; rotate by issuing a new key, proving one staging send, then revoking the old (production-launch §2) | key not in DB | one staging confirmation arrives with no provider footer/unsub |
| `ADMIN_TOTP_KEY` | Coolify (Admin resource) | Admin TOTP enrolment/verify | operator second factor | — | rotating invalidates existing enrolments → re-enrol operators in a planned window | not in DB; enrolment state is | TOTP verify works post-rotation; `ADMIN_TOTP_REPLAY` guard intact |
| `ADMIN_AUDIT_KEY` (+ `ADMIN_AUDIT_KEY_ID`, `ADMIN_AUDIT_PREVIOUS_KEYS`) | Coolify (Admin resource) | append-only audit signing | sign/verify audit chain | — | **key rollover by design:** new key + id, old key moves to `ADMIN_AUDIT_PREVIOUS_KEYS` so old entries still verify; never drop a previous key still covering retained audit | audit chain is in DB; a restore must still verify under the key id each entry was signed with | new entries verify under the new id; historical entries verify under previous ids |
| `GITHUB_TOKEN` | the **CI secret store** for CI image flows; a deployed content-publish service that ever consumes it → **Coolify** of that service — one per actual consumer, never both | content publish / CI image flows | repo/publish scope only | — | rotate in GitHub; least-scope PAT or App token | not in DB | **absent** from runtime/admin/media env (`FOREIGN_ENVIRONMENT`, `MEDIA_FOREIGN_CREDENTIAL`) |

### 2.3 Object storage (media) and age identities

| Secret | Custodian | Consumer | Scope | Owner-only | Rotation overlap | PITR / escrow | Verify |
|---|---|---|---|---|---|---|---|
| `MEDIA_S3_ACCESS_KEY_ID` / `MEDIA_S3_SECRET_ACCESS_KEY` (Cloud.ru S3, bucket `mikluha-maklai`; also `AWS_SECRET_ACCESS_KEY` / `S3_SECRET_ACCESS_KEY` references) | Coolify (media worker) | media worker storage | the Mikluha media prefix only; a **distinct S3 prefix that cannot overlap Refref** (production-launch §5) | — | issue a new key pair, repoint the worker, prove read-back, then revoke the old | objects are not DB rows; backup covers DB, not S3 objects | public/private read-back passes; key absent from admin/commerce env |
| `mikluha-recovery` age identity (backup encryption) | **public recipient** in host/SOPS; **private decrypt identity in offsite owner escrow, never on VPS/GitHub/CI** | encrypted `pg_dump` / backup bundles | decrypt Mikluha backups only | yes | rotating the recipient re-encrypts future backups; keep the old private identity in escrow as long as backups encrypted to it are retained | **critical:** a restore needs the private identity that matches the recipient the bundle was encrypted to — rotating the recipient without retaining the matching private identity makes older bundles unrecoverable | record only the public recipient / public-half fingerprint in evidence; prove one isolated restore drill |

### 2.4 Legacy / draining — retain, do not rotate now

| Secret | State | Action |
|---|---|---|
| `REFREF_API_KEY`, `REFREF_BUSINESS_ID`, `REFREF_BUSINESS_SLUG` | legacy referral path; native is `NATIVE_NO_REFERRAL` and makes no Refref calls | **retain until legacy drain; do not rotate now** (TOUR-50 current acceptance). Still listed in `FOREIGN_ENVIRONMENT` so it never leaks into admin/media |
| Sveltia editor PAT + Sveltia-only S3 writer credential | retired editing path (SSR-only; clean-slate) | retire **only after** the exact consumer scope is identified (TOUR-66); do not revoke shared/backup/new-stack credentials by name |

## 3. Rotation runbook (owner-executed; this document does not perform it)

1. **Classify first.** Confirm the row's authoritative custodian and that the target is
   Mikluha-exclusive. Shared principals (Alfa merchant, shared canary, shared proxy/control plane,
   others' backups) are out of scope and need their own owner GO via VPS-15.
2. **Bank/fiscal rotations** (Alfa, SBP, Ferma): follow the capability-conditional procedure in §3.1,
   not a single universal rule.
3. **App/DB/service rotations** (runtime/operator/admin/media DB, Notisend, S3, TOTP, GitHub): issue
   new → repoint the single custodian (Coolify env / transient root-`0600` file) → prove read-back →
   revoke old. Audit signing uses key-id rollover (§2.2), never a hard cut.
4. **Record** the changed resource, its authority (Coolify / host-SOPS / offsite escrow), consumer and
   post-state in VPS-15 / infrastructure inventory. `CUSTODY_IMPACT: YES`. No value anywhere.

### 3.1 Bank/fiscal rotation — capability-conditional (P1)

There is **no single correct bank rotation**: the right procedure depends on what the provider
actually supports, which is **not yet confirmed** (Alfa/Ferma capabilities are TOUR-83/5/9). A
"parallel credential" is itself an overlap and is only valid if the provider permits two live
credentials — so the universal "no overlap, but stage a parallel key" wording is replaced by these
conditional scenarios. The owner selects the one matching the confirmed capability:

- **(a) Provider supports simultaneous/overlapping credentials.** Issue the new credential, prove it
  on an owner 1 ₽ / read-back operation in a non-sales window, cut consumers over, then revoke the
  old. True zero-gap rotation.
- **(b) Provider allows only immediate replacement (no overlap).** Schedule a maintenance window with
  **sales CLOSED**; first drive every in-flight operation to a terminal or read-back-resolved state
  (no live UNKNOWN), then replace the credential and prove the new one. A brief gap is expected and
  acceptable *because sales are closed*; never rotate under live traffic in this mode.
- **(c) Credential is tied to the bank connection/merchant binding.** Treat it as a connection change:
  coordinate with the provider so the connection and its credential move together; this is a shared
  banking-principal operation → explicit owner GO via VPS-15, out of scope for an app-level rotation.
- **(d) Old operations readable by the new credential but not re-executable.** Acceptable for
  read-back only; confirm that reconciliation of pre-rotation operations works under the new
  credential before revoking the old.

**UNKNOWN read-back must survive the change (all scenarios).** Reconciliation of an in-flight
`UNKNOWN` operation keys on the provider/source operation ID, not on the credential, so rotation must
never make an UNKNOWN operation unreadable: either resolve all UNKNOWN operations *before* revoking
the old credential, or retain the old credential in a read-only capacity (if the provider allows it)
until none remain. A rotation that strands an unresolved UNKNOWN operation is not permitted.

## 4. Key / DB divergence after restore

A logical/PITR restore reintroduces the DB-role passwords and any DB-stored state **as of the restore
point**. If a password or key was rotated *after* that point:

- DB-role passwords: the restored copy expects the pre-rotation password — re-apply the current
  rotation on the restored copy before repointing live consumers; never install a recovery private
  key into runtime/VPS where it does not belong.
- age recovery identity: the restored bundle is decryptable only by the identity matching the
  recipient it was encrypted to — keep every still-relevant private identity in offsite escrow.
- audit key: entries verify under the key id they were signed with; keep previous keys in
  `ADMIN_AUDIT_PREVIOUS_KEYS` for as long as those entries are retained.

Clean-slate scope: for the new DB, automatic encrypted/off-host logical backup + **one successful
isolated restore** before real Admin/content/legal data entry is sufficient; full PITR and
independent external custody-device qualification are deferred to before real sales (owner accepts
the edit-loss window between scheduled dumps).

## 5. Verification (planned checks vs. performed — P2)

**Performed by this document: none.** This is a source-only artifact; it runs no check, rotates
nothing and reads no production secret. The rows below are the **planned** verification matrix for the
owner to execute later, each with synthetic data and redacted evidence only.

| Planned check | Status |
|---|---|
| invalidated-old-key: old credential refused after rotation | NOT_RUN |
| bank/fiscal rotation per the §3.1 scenario matching the confirmed provider capability | NOT_RUN (capability unconfirmed, TOUR-83/5/9) |
| UNKNOWN-operation read-back still works across a credential change (§3.1) | NOT_RUN |
| rotated DB passwords accepted by their isolated login, refused for foreign ones (`ADMIN_ENVIRONMENT_FOREIGN`, `MEDIA_FOREIGN_CREDENTIAL`) | NOT_RUN |
| service restart picks up the repointed env | NOT_RUN |
| restore-window divergence handled per §4 | NOT_RUN |
| audit-key rollover: historical entries verify under previous key ids | NOT_RUN |
| no secret value, PD package or bearer token in CI logs, PRs, Plane or chat | NOT_RUN |

A check is marked performed only with its own redacted evidence; do not relabel a planned check as
passed without it.

## 6. Boundaries

Exact-SHA deployment improvements stay in [ART-253 / TOUR-17](https://app.plane.so/art-workspace/browse/TOUR-17/),
not here. This runbook installs nothing, rotates nothing, and reads no production secret value. Real
host/credential changes are owner-authorized, specific, and recorded through VPS-15 with
`CUSTODY_IMPACT: YES` and a post-change read-back.

---

## Review resolution (2026-10-31, PR #67)

- **P1 — contradictory no-overlap bank rotation:** §3.1 replaces the universal rule with
  capability-conditional scenarios (simultaneous keys / immediate replacement / connection-tied /
  read-only-old), keyed to as-yet-unconfirmed Alfa/Ferma capability (TOUR-83/5/9), and makes
  UNKNOWN-operation read-back survival a hard requirement across any credential change.
- **P2 — alternative custodians:** §0 adds a one-custodian-per-secret resolution rule; the Alfa/SBP/
  Ferma, migration-owner, admin-DB, TOTP, audit-key and GitHub-token rows now name a single store of
  record (transient bootstrap files marked as materialisations, not second custodians).
- **P2 — tests only listed:** §5 now distinguishes planned checks (all NOT_RUN — source-only) from
  performed ones, and forbids relabeling a planned check as passed without its own redacted evidence.
