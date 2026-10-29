# PR #55 / #18 review resolution

Review inputs: Mikluha `38603c5aec2247e692ab4580de326d14e5b2880f`, infrastructure
`6a13248b1b7432229801ac512b42f4d0d0fb56de`, GPT and OPUS owner-provided reports.
This is a UI composition contract, not Agent A's final HTTP schema or a launch receipt.

## Keep from original plan

Server-owned prices/options/cutoffs, disabled promo/Apply, inert arrival, source-only preview,
adult initial group and manager-assisted children, UNKNOWN fences, legal and custody gates.
Reuse Flexperiment's component and shared credentials per explicit owner instruction.

## Adopt from alternative plan

| Item | Impact | Decision and reason |
| --- | --- | --- |
| GPT payment A → B → A | critical fix | Actually clear selected payment on every condition transition before rendering children. Returning to A cannot restore it. Retain tourist/contact input. |
| GPT stale quote/terms/options | material improvement | Explicit `refresh_required` codes and user-triggered read-only quote refresh. No implicit second booking submission. Require fresh selection; re-confirm consent when legal document versions change. Failed refresh stays recoverable. |
| GPT hung SDK | material improvement | 10-second deadline, failed-script removal, listener/timer cleanup and new promise on retry. Regression uses no load/error event and then a late callback. |
| GPT key pairing | material improvement | Read-only Coolify audit checks matching 20 characters after prefixes, source/target equality and website scopes in process. Only booleans leave the host. |
| OPUS request identity | material improvement | Draft carries trusted session `clientRequestId`; UNKNOWN shows it. Recovery bootstrap blocks a remounted form. Durable ID/session and server idempotency remain A integration prerequisites. |
| OPUS quote correlation | material improvement | Opaque input revision changes on participant add/remove and committed changes to qualified pricing fields. Ordinary tourist details do not invalidate the quote. Quote must echo the revision, match departure/session/count and be the latest refresh. Out-of-order replies are ignored. |
| OPUS consent guard | material improvement | Draft builder rejects absent/false adult and PD confirmations independently of browser validation. |
| OPUS dispatch certainty | material improvement | Adapter can return `not_dispatched` only if it proves no dispatch occurred. All unclassified exceptions still mean UNKNOWN. |
| OPUS unnecessary CAPTCHA reset | minor enhancement | Preserve a valid unconsumed proof during passenger/quote edits; it is not a quote signature. Submission consumes it before await; provider expiry/error/manual retry still invalidates it. |
| OPUS accessibility/types/lab/copy | minor enhancement | Match jsdom type major, name widget group with a role, remove duplicate price live region and static status announcements, distinguish mock expiry/error, describe final PR result. |
| OPUS infra diagnostics | minor enhancement | Only allowlisted fixed refusal codes may be printed; arbitrary exception messages remain suppressed. |

## Reject from alternative plan

Generating a new UUID per mount does not solve reload or cross-tab duplication. The composition
adapter must bootstrap a durable form-session ID, retain it through quote/consent/CAPTCHA retries,
and recover its authoritative state before enabling another POST. The server must atomically
enforce one operation/hold per owner-scoped request ID and reject mismatched payload replays.
The ID is a support reference, not an authorization credential. No PD or proofs go to localStorage.

Do not infer "not sent" from TypeError, navigator online state or a lost response: the request
may have reached the server. Keep the existing conservative UNKNOWN behavior in those cases.

Do not replace/rotate the shared provider keys: the owner explicitly requested reuse. Shared
quota, provider settings and rotation affect both consumers and require coordinated operations.

The second review identified excessive invalidation and an overbroad quote DTO at `ed5cf45`.
The minimal pricing projection and text-input regressions supersede that behavior; see
`2026-10-30-checkout-pricing-inputs-design.md`. A schema flag alone does not qualify PD processing.

## Conflicts / decisions needed

No owner decision is needed for these source fixes. A must agree the final transport/session
mapping before integration. A's durable bootstrap/reconciliation, server idempotency and host
validation are not implemented by this UI PR. Tests of the UI contract do not qualify them.

For shared keys, A must require successful provider validation AND exact membership of `host`
in a server-configured Mikluha allowlist (including any deliberately admitted non-default port).
Empty, malformed or Flexperiment-only hosts fail closed; no suffix match, request Host reflection,
or provider `status=ok` alone. The provider may return empty host, so deny it in this profile.
See [Yandex validation](https://yandex.cloud/en/docs/smartcaptcha/concepts/validation) and
[domain validation](https://yandex.cloud/en/docs/smartcaptcha/concepts/domain-validation).
Independent negative E2E must cover foreign/empty host, expired/replayed proof and provider failure.

TOUR-80/84 must qualify third-party JavaScript on the tourist/passport form, technical data
processing, disclosure, legal basis and final field list before publication/activation. This
source patch neither approves the processing nor changes published legal documents.

## Risk delta

Additional A integration dependencies are explicit: durable session bootstrap and recovery;
read-only quote endpoint echoing the input revision; typed definitive no-side-effect refusals;
server CAPTCHA host policy. None creates a server endpoint, local pricing or seat policy.
Provider-domain configuration and real token verification remain NOT_RUN. Fresh independent
custody/restore is still CUSTODY_PENDING under VPS-18; no historical receipt is extended.

## Revised merged plan

Fix and test source behavior, perform read-only key audit, update PRs and Plane evidence. Keep
both PRs draft for review. No merge, deployment, provider change, new capture or public launch.
