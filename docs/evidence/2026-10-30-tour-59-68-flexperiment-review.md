# Flexperiment reuse review for Mikluha legal/Admin privacy

Date: 2026-10-30. Source review, not deployment or legal approval.
Mikluha base: `68130f0`. Flexperiment checkout:
`c8bad757c9daa04385f9cf5e95bf6e07b185080a`.
Current execution scope/status and owner questions remain in Plane TOUR-59/68.

## Conclusion

Reuse selected security, legal-evidence and disclosure patterns. Keep Mikluha's
existing PostgreSQL Admin architecture. Flexperiment's singleton Control Room
does not supply an approved retention policy for Mikluha administrators.
Neither a public provider policy nor another merchant's legal approval is
approval of Mikluha's exact new text.

## Architecture and access comparison

Paths below are relative to the named repository.

| Concern | Flexperiment V2 evidence | Application to Mikluha |
| --- | --- | --- |
| Frontend | `apps/admin/components/AdminApp.tsx`, `apps/admin/lib/api.ts`: static UI, same-origin API, cookie authentication, no-store reads; server authorizes requests | Same pattern already used by `control-room/`; no frontend replacement needed |
| API isolation | `commerce-v2/src/server.ts`, `app.ts`: Admin routes execute in the Commerce process with its database/dependencies | Keep Mikluha's separate Admin API process and disjoint `admin_app` / `admin_publisher` logins, `commerce/src/bin/admin-api.ts`; do not combine service credentials |
| Roles | `control-room-totp.ts`: `singleton-admin`; V2 route middleware establishes this identity | Preserve named OWNER/EDITOR accounts and server permissions in `commerce/src/admin/auth.ts`; publication is OWNER-only |
| MFA | `control-room-totp.ts`, `app.ts`: encrypted account-bound TOTP seed, replay refusal, code spent transactionally with session creation, SSH reset revokes sessions | Equivalent protections already exist in Mikluha; reuse test scenarios and recovery principles, not SQLite storage |
| Sessions | `control-room-auth.ts`: signed cookie plus live DB record, Secure/HttpOnly/SameSite=Strict, absolute 12 hours | Keep Mikluha's opaque token MAC, host-prefixed cookie, 30-minute idle and 12-hour absolute limits and revocation under locks |
| Client IP trust | `control-room-client-ip.ts`: canonical IP, exact transport peer allowlist, only proxy-replaced X-Real-IP accepted; missing config/source fails closed | Useful hardening pattern. Mikluha currently parses a single X-Forwarded-For without checking the socket peer (`commerce/src/rate-limit.ts`). Its private network/sanitizing proxy assumption needs deployment evidence or an adapted peer check. No bypass on a deployed service is claimed |
| Request origin | Flexperiment middleware rejects a supplied foreign Origin but allows omission | Preserve Mikluha's stricter write-origin/host checks; no reason to weaken them |
| Audit | `control-room-auth.ts`: actor/action/entity/details rows; selected key redaction | Keep Mikluha's database-enforced append-only audit, MAC attestation and session/login linkage. Flexperiment's helper and migration 0005 are not an equivalent DB enforcement boundary; its regex also covers fewer secret field names |
| HTTP logging | `deploy/v2/fast-cut/admin-common.conf`: access logs off and nginx error log discarded to avoid sensitive request URLs | Reuse the minimization principle. Mikluha's `control-room/nginx.conf.template` disables access logs but leaves error logging at the nginx default. Do not describe all proxy/runtime/provider logs as absent without checking those layers |

The IP/logging differences are source findings for the actual Admin privacy
slice; they are not authorization to change shared proxy/network/host state.

## Retention: what the source actually implements

- Flexperiment `commerce-v2/src/app.ts` removes expired Admin sessions inside
  the next **successful** password/TOTP login transaction. The predicate also
  includes revoked rows older than seven days. Because expiration is an OR
  condition and the issued TTL is 12 hours, this is not a seven-day minimum
  retention rule. Without another successful login it supplies no maximum
  cleanup delay.
- No age-based cleanup of `control_room_audit_log` or
  `control_room_login_rate_limits` was found in the examined runtime/migrations.
  An index named `control_room_sessions_cleanup` is not a scheduled cleanup job.
- `commerce-v2/src/pd-retention.ts` explicitly requires a reviewed policy with
  no default durations. It is an offline customer-data cleanup engine, not an
  installed Admin audit/session retention worker. Its `"session"` target is
  the customer auth table, not `control_room_admin_sessions`.
- `docs/legal/stage-a/2026-10-11-draft/OWNER_APPROVAL.md` labels its proposed
  retention package as non-active settings. Its customer credentials/security
  telemetry proposals cannot be imported as approved Admin audit durations.
- `docs/legal/closed-paid-test/2026-10-16-review-5/README.md` records approval
  and activation for the closed Test Course release. That limited buyer-policy
  scope does not establish employee/Admin retention for a different operator.
- Mikluha retains identity-bearing Admin sessions/audit; session validity is
  not row deletion. Audit and session FK/history constraints need an explicit
  design before pruning. A generic DELETE copied from SQLite is unsuitable.

At the initial review, an owner decision was still needed: retention purposes/durations for Admin account
identity after disabling access, expired/revoked session metadata, security
audit, and any separate publication evidence. Keep immutable legal publication
evidence distinct from disposable login/security metadata. Any change to old
migrations is out of scope; a retention implementation would be forward-only.

## Adman facts recovered without another owner questionnaire

Flexperiment `docs/legal/stage-a/2026-10-11-candidate/README.md` and
`privacy.md` record the owner's confirmation of the Adman VPS location:
630510, Novosibirsk oblast, Kudryashovsky, Svetlaya 21. Review.5 `privacy.md`
retains those facts. Mikluha's AGENTS.md identifies the shared Adman VPS.
This is existing owner evidence for the shared server, not a fresh panel audit.

Read on 2026-10-30 from the supplier's official documents page:

- [Documents](https://adman.com/pages/document/).
- [Technical passport, dated 2025-03-24](https://adman.com/tech_passport_adman.pdf):
  LLC Adman, INN 7733576655, operates the data centre at the matching address.
- [Provider privacy policy, dated 2020-02-04](https://adman.com/privacy_policy_admancom.pdf):
  includes LLC Adman and Macrocomunidad C.I.P. Urbanización Samara; describes
  provider account/service data, technical headers/IP/cookies and staff access
  for necessary tasks; states storage in the Russian Federation/Novosibirsk.

The provider's website/account cookies and analytics are not automatically
Mikluha cookies or recipients of tourist data. The named second entity is not
proof of an actual transfer of Mikluha visitor/Admin data to it. Conversely,
the data-centre location alone does not prove that every support, backup or
other provider flow has no foreign recipient. Flexperiment already records
this applicability uncertainty; preserve it in the owning review.

The first request for basic Adman identity/location can therefore be retired.
Use the supported hosting facts in the Mikluha draft without asserting a new
account-specific processor agreement, no foreign recipients, or universal
Russia-only processing. Cloud.ru media/backups remain a separate actual flow;
do not copy Flexperiment's unrelated Kinescope/LMS/REG.RU functions into Mikluha.

## Legal publication reuse

Flexperiment's useful pattern is exact document version/hash/manifest and a
record of the real owner decision, separate from installation/sales approval
(`commerce-v2/src/legal-control.ts`, `owner-legal-decision.ts`,
`docs/legal/OWNER_LEGAL_DECISIONS.md`). Its COURSES/LAB activation schema is not
Mikluha's legal authority and is not a transplant target.

Mikluha migration 0019 already supplies OWNER-only legal publication, immutable
version/document hash/text hash/effective date/approval, and the `public_legal`
view. TOUR-59 should consume that Commerce authority at request time and render
an explicit unavailable state on failure; baked legal text cannot be an outage
fallback. Build/code identity remains separate from mutable legal authority.

## Validation and limits

Flexperiment dependencies were aligned with the existing lockfile using
`pnpm install --frozen-lockfile --ignore-scripts`; no manifest/lock/source edit.
An initial test import failed because local `qrcode` was missing; after that
dependency repair the complete selected run passed:

`pnpm exec vitest run commerce-v2/test/control-room-login.test.ts commerce-v2/test/control-room-totp.test.ts commerce-v2/test/control-room.test.ts commerce-v2/test/legal-control.test.ts commerce-v2/test/pd-retention.test.ts`

Result: **5 files, 73 tests passed**. These are local source tests, not a new
production/proxy/browser/provider/legal qualification. No server operation,
credential change, legal publication, domain switch or sales activation.
`CUSTODY_IMPACT: NO` — source review/documentation only.

## Subsequent owner retention preference

The owner subsequently proposed indefinite or product-lifetime storage.
The candidate uses product operation as an upper bound for necessary minimal
Admin access/action/publication evidence, with earlier purpose-based termination
and distinct legal holds. Session validity and throttle cleanup do not change.
Exact privacy/cookies candidate bytes in docs/legal/2026-10-30-ssr-admin remain
unapproved and unpublished; the preference is not a legal-publication receipt.
