# SSR/Admin legal candidate — 2026-10-30

Candidate revision: `2026-10-30.ssr-admin.review.2`.
Status: DRAFT, NOT PUBLISHED, no exact-byte OWNER approval yet. This directory
is not imported or activated automatically. Effective date is intentionally not
invented: OWNER chooses it at legal publication (Moscow date, no backdating).

- `privacy-policy.md`: minimal actual SSR/Admin/direct Cloud.ru disclosure.
- `cookies.md`: actual Admin cookie; removes retired booking-cookie claims.
- `SHA256SUMS`: exact candidate text bytes for review. Commerce separately
  computes its document and body hashes when OWNER publishes.

The owner proposed indefinite or product-lifetime Admin retention. Candidate
uses product operation as an upper bound for necessary minimal access/action
evidence, with earlier purpose-based termination and separate lawful holds.
No automatic session/audit/backup deletion is claimed. This proposal is not
approval of the exact public wording, an installed erasure process, a provider
account qualification or future sales processing.

The old `content/legal/*.yml` is retained without rewriting historical legal
bytes. TOUR-59 removes its runtime fallback. OWNER must enter/publish these
candidate bodies through the existing Admin legal publication operation after
review; code merge alone must not activate them. Preserve prior publications.

Before exposure: qualify actual proxy/log/access settings and applicable
provider operations, new DB backup and isolated restore under existing phase-A
requirements, and the concrete supported process for restriction/termination
requests. Do not claim these source drafts prove an operational privacy gate.
New host operations require scoped owner authorization.

Sources: Flexperiment review in
`docs/evidence/2026-10-30-tour-59-68-flexperiment-review.md`; Mikluha
`commerce/src/admin/{api,auth,attestation}.ts`, migrations 0011/0019,
`control-room/nginx.conf.template`, media runbook/provider evidence;
[Adman passport](https://adman.com/tech_passport_adman.pdf),
[Adman provider policy](https://adman.com/privacy_policy_admancom.pdf),
[152-FZ art. 5](https://www.consultant.ru/document/cons_doc_LAW_61801/96fbc469f91f57235cc842a85e0516a99f23dc85/).

CUSTODY_IMPACT: NO — reviewable source only; no deployed state changed.

## Review.2 changes and approval boundary

Replaces the prior exact-byte approval request; prior privacy/cookies SHA-256s
are historical draft identities, not approvals of this revision. Runtime source
is unchanged. Review resolution and direct read-only logging facts are in
`docs/evidence/2026-10-30-tour-68-review-resolution.md` and
`docs/evidence/2026-10-30-tour-68-logging-readonly.json`.

Review.2 separates subjects/purposes/bases, organiser/review publication and
image rights, account/session/audit/legal-evidence termination, a proposed
quarterly necessity review, and access-query response timing. It removes the
speculative public Macrocomunidad paragraph and explains cookie persistence.
The Adman policy §7 explicitly places the servers of both named entities in
Russia/Novosibirsk; a foreign-looking name does not prove foreign-territory
transfer. This does not create a blanket finding for unrelated provider flows.

The quarterly review and termination procedure are proposed organisational
commitments for this candidate, not an installed timer or an executed erasure.
Existing append-only audit and restricted session/account FKs do not support a
naive DELETE. Before real use, qualify the permitted account/credential disposal,
session-metadata minimisation, and lawful-hold/history preservation procedure.
Any necessary database change is forward-only, separately reviewed, and owned
with the canonical migration journal. Do not rewrite old migrations or remove
publication/payment evidence to satisfy a generic purge.

Before exposure, also establish the actual RKN notification scope/exemption,
rights/consents for each real organiser/review/person image, applicable account
provider terms (including commissioned processing where required), and category
review of preserved test-payment/fiscal evidence without assuming all subject
identities are synthetic. Old/demo media are not reapproved. These actual-flow
checks do not impose future sales qualification or whole-VPS review.
