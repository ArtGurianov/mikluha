# SmartCaptcha reuse and configuration

Source: Flexperiment `apps/lab/components/SmartCaptcha.tsx`, snapshot
`be55bb755100535fd2af5f2a407b1be0199e2c40`. The provenance and small local changes are in
`components/booking/vendor/README.md`. There is one reused loader/widget lifecycle, not a
second Mikluha SDK adapter. The booking wrapper preserves input on definitive refusal and
remounts the widget for a fresh one-use proof. UNKNOWN still blocks resubmission.

## Coolify authority — VPS-18

OWNER explicitly authorized copying existing Flexperiment keys on 2026-10-29 and SSH work on
`adman-vps`. The read-only Coolify connector could inspect keys but could not write envs, so the
copy used the installed Coolify Laravel models through SSH, inside one database transaction.
Encryption casts and Coolify's production-to-preview creation hook were retained. Values never
left server process memory/Coolify encrypted storage, and no value/hash was printed.

| Resource | Key or reference | Scope |
| --- | --- | --- |
| Flexperiment project `wclu2wovf4ctpbgam3h7grzb`, LAB `cvwxkftmub9iso74eyxahnpn` | `NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY` | Source public key; unchanged |
| Same project, Commerce `jmawd0cmudtiwtquptyvhm0l` | `YANDEX_SMARTCAPTCHA_SERVER_KEY` | Source private key; unchanged |
| Mikluha project `crx7vr9fwxcgmwrbthlofeb5` shared variables | Both keys, copied values | Coolify is credential authority |
| Mikluha website `pxetekoyzceundmfpuapik4q` | `NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY={{project.NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY}}` | Production and preview; build-time only |

The private key is **not** a website variable or Docker build arg. No Mikluha Commerce application
currently exists in this Coolify project. When Agent A integrates server verification, its private
runtime can explicitly reference the project server key; copying it does not create a verifier,
validate a browser proof or change booking admission. The root and SSR Dockerfiles accept only
the public build arg, matching the reused component's `NEXT_PUBLIC_…` contract.

Read-back on 2026-10-29 confirmed public/server equality inside Coolify, resolved public references
for both website scopes, and no private key in website env. Existing site container ID/start time
was unchanged. No deployment, restart, rotation or public-sales activation was performed.

`CUSTODY_IMPACT: YES`. [VPS-18](https://app.plane.so/art-workspace/browse/VPS-18/) owns recovery
tracking. `CUSTODY_PENDING`: the dated control DB/APP_KEY snapshot predates this change; fresh
encrypted capture, independent external read-back and isolated restore remain outstanding under
the infrastructure owner's procedure. Read-only drift before and after: identical findings,
868 configs, 17 existing config changes, 58 package rows, 2 unit changes, 10 unverified bundles.
This task does not repair unrelated drift or claim recovery from the successful copy.

## Qualification boundary

The development lab uses a synthetic widget by default. Its explicit "Реальная CAPTCHA Flexperiment"
switch mounts the reused component; it needs a public key in that development process. This task
does not copy a private key to local files. The lab is excluded from static and SSR release routes.

DOM tests exercise the reused component's missing key, script load/error/retry, reset, token expiry,
network/JavaScript failure, stale callback and cleanup behavior using a synthetic SDK. Real widget
solve, token validation, allowed-domain configuration for Mikluha, actual provider traffic/CSP and
native booking E2E remain unqualified. Before activating native checkout, qualify them in the
selected renderer and consume Agent A's server verification, replay/idempotency and hold policy.
Never infer server acceptance from the client's `onToken` callback.

## Review follow-up: pair and origin isolation

The 2026-10-29T17:27:14Z read-only Coolify audit confirmed source and target pair correspondence,
source/target equality, both website references and no website server key. It compared the next
20 characters after the key prefixes internally, following [Yandex key format](https://yandex.cloud/en/docs/smartcaptcha/concepts/keys).
Only booleans were emitted. Infrastructure PR #18 keeps the receipt and a repeatable read-only
audit; the copy procedure was not rerun. No provider mutation or real-token validation occurred.

Shared keys are the owner's explicit choice. A must validate provider response `host` against an
explicit server-owned Mikluha allowlist, rejecting missing/empty/foreign hosts even with status
ok. Provider allowed domains must separately be inspected and real Mikluha/foreign-origin token
tests must pass before activation. These remain unqualified; Coolify env equality cannot prove
provider settings. Shared quotas/settings/rotation affect Flexperiment too. Do not revoke them.

The reused loader now times out after 10 seconds and removes failed scripts/listeners before
retry. Unconsumed proofs survive ordinary quote/passenger edits; submit consumes the proof before
await, including UNKNOWN. Session, refresh and origin requirements are recorded in
`docs/plans/2026-10-30-checkout-review-resolution.md` and TOUR-49; legal/PD qualification stays
with TOUR-80/84.
