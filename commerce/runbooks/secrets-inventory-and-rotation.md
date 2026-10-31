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
| Alfa merchant API/gateway credential (native card + SBP, one merchant) | Coolify (Mikluha commerce env) | native payment operations (TOUR-77), refunds | create/confirm/refund operations for the Mikluha merchant only | Coolify env var on `mikluha-commerce`; name recorded here, value never | issued in the Alfa cabinet by the owner; blast radius = all native money operations | yes — issue/rotate/revoke in the Alfa cabinet | **bank has no overlap window** → stage a parallel credential before cutover, prove the new one on a 1 ₽ owner test in a non-sales window, then invalidate the old; never a gap that strands an in-flight UNKNOWN operation | none in DB; operations reference provider IDs, not the key | owner confirms in cabinet + one proven read-back operation; record provider/connection IDs only |
| SBP-specific credential (if distinct from the card merchant) | Coolify | native SBP operations | SBP init/refund | Coolify env on `mikluha-commerce` | Alfa/SBP cabinet | yes | same no-overlap rule as the card credential; rotate the two together or with a proven staging step each | n/a | n/a | proven SBP read-back on a test operation |
| Ferma / OFD.ru fiscal credential | Coolify (or host/SOPS if host-level) | fiscal document issue/read-back via the Alfa→Ferma chain | issue/correct/read fiscal documents for the Mikluha owner profile | Coolify env (name only) | OFD.ru cabinet | yes | stage + prove before invalidating; a fiscal key gap blocks closing receipts | fiscal outbox retries are idempotent on the provider ID, not the key | owner confirms the real Alfa→Ferma chain for card/SBP/first-instalment/top-up/refund before any live receipt (fiscal §2, §8) |

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
| migration owner — `MIGRATION_DATABASE_URL` | offsite owner / root-`0600` host file | one-off migrate container | owns schema, runs attested migrations | `/etc/mikluha-commerce/migration.env` (root `0600`), removed after bootstrap unless it is the approved owner store | yes | rotate in DB; no running service holds it, so no overlap problem | password rotation must be re-applied on the restored copy — a restore reintroduces the pre-rotation password (key/DB divergence, §4) | login works for migrate, never present in the runtime/admin/media env |
| runtime — `DATABASE_URL` (`commerce_runtime` in `commerce_app`) | Coolify | long-running commerce service | app DML under `commerce_app` grants | Coolify env on `mikluha-commerce` | — | rotate DB password + Coolify env together; brief restart, not a bank-style no-overlap case | restore reintroduces the old password until re-rotated | `pg` connects; it is **absent** from admin/media processes (`assertAdminEnvironment`, `MEDIA_FOREIGN_CREDENTIAL`) |
| operator — `OPERATOR_DATABASE_URL` (`commerce_operator_login` in `commerce_operator`) | root-`0600` host file | one-off `sales` / `eis` containers | sales switch + EIS filing | `/etc/mikluha-commerce/operator.env` (root `0600`) | yes | rotate in DB + rewrite the env file | restore reintroduces old password | runs only in a one-off container, never `docker exec` into the service |
| admin app / publish / operator — `ADMIN_DATABASE_URL`, `ADMIN_PUBLISH_DATABASE_URL`, `ADMIN_OPERATOR_DATABASE_URL` | Coolify (Admin resource) / host file as deployed | Control Room / Admin API | isolated admin capabilities; must not carry commerce/media/operator creds | Admin resource env | — | rotate per login with its service restart | restore reintroduces old passwords | `ADMIN_LOGIN_NOT_ISOLATED` / `FOREIGN_ENVIRONMENT` guards hold |
| media — `MEDIA_DATABASE_URL` (`media_worker`) | Coolify (media worker) | media worker only | media rows only; isolated login | media worker env | — | rotate + restart media worker | restore reintroduces old password | `MEDIA_LOGIN_NOT_ISOLATED` guard holds |

### 2.2 Application secrets, signing/service tokens

| Secret (env) | Custodian | Consumer | Scope | Owner-only | Rotation overlap | Restore impact | Verify |
|---|---|---|---|---|---|---|---|
| `NOTISEND_API_KEY` (+ non-secret `NOTISEND_FROM_EMAIL/NAME/REPLY_TO`) | Coolify | confirmation email | send transactional mail | — | Notisend has **no idempotency key** — never resend an unknown-outcome message; rotate by issuing a new key, proving one staging send, then revoking the old (production-launch §2) | key not in DB | one staging confirmation arrives with no provider footer/unsub |
| `ADMIN_TOTP_KEY` | Coolify/host (Admin) | Admin TOTP enrolment/verify | operator second factor | — | rotating invalidates existing enrolments → re-enrol operators in a planned window | not in DB; enrolment state is | TOTP verify works post-rotation; `ADMIN_TOTP_REPLAY` guard intact |
| `ADMIN_AUDIT_KEY` (+ `ADMIN_AUDIT_KEY_ID`, `ADMIN_AUDIT_PREVIOUS_KEYS`) | Coolify/host (Admin) | append-only audit signing | sign/verify audit chain | — | **key rollover by design:** new key + id, old key moves to `ADMIN_AUDIT_PREVIOUS_KEYS` so old entries still verify; never drop a previous key still covering retained audit | audit chain is in DB; a restore must still verify under the key id each entry was signed with | new entries verify under the new id; historical entries verify under previous ids |
| `GITHUB_TOKEN` | host/SOPS or CI secret store | content publish / CI image flows | repo/publish scope only | — | rotate in GitHub; least-scope PAT or App token | not in DB | **absent** from runtime/admin/media env (`FOREIGN_ENVIRONMENT`, `MEDIA_FOREIGN_CREDENTIAL`) |

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
2. **Bank/fiscal (no overlap) rotations** (Alfa, SBP, Ferma): stage a parallel credential, prove it on
   an owner 1 ₽ / read-back operation in a non-sales window, resolve any in-flight UNKNOWN by
   read-back, then invalidate the old. Never leave a window that strands an in-flight operation.
3. **App/DB/service rotations** (runtime/operator/admin/media DB, Notisend, S3, TOTP, GitHub): issue
   new → repoint custodian (Coolify env / root-`0600` file) → prove read-back → revoke old. Audit
   signing uses key-id rollover (§2.2), never a hard cut.
4. **Record** the changed resource, its authority (Coolify / host-SOPS / offsite escrow), consumer and
   post-state in VPS-15 / infrastructure inventory. `CUSTODY_IMPACT: YES`. No value anywhere.

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

## 5. Test scenarios (synthetic, redacted evidence; no secrets in logs/issues)

Prove, with redacted evidence only: invalidated-old-key (old credential refused after rotation);
staged-overlap acceptance for bank/fiscal; rotated DB passwords accepted by their isolated login and
refused for foreign ones (`ADMIN_ENVIRONMENT_FOREIGN`, `MEDIA_FOREIGN_CREDENTIAL`); service restart
picks up the repointed env; restore-window divergence handled per §4; and that no secret value, PD
package or bearer token appears in CI logs, PRs, Plane or chat.

## 6. Boundaries

Exact-SHA deployment improvements stay in [ART-253 / TOUR-17](https://app.plane.so/art-workspace/browse/TOUR-17/),
not here. This runbook installs nothing, rotates nothing, and reads no production secret value. Real
host/credential changes are owner-authorized, specific, and recorded through VPS-15 with
`CUSTODY_IMPACT: YES` and a post-change read-back.
