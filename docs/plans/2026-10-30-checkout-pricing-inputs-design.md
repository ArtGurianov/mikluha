# PR #55: pricing inputs and stable form editing

Follow-up to owner-provided OPUS/GPT reviews of `ed5cf455962e0b7cb9db929dfbcfd3c7656fb1a5`.
Both identify unnecessary personal data in quote refresh; OPUS also identifies per-keystroke
quote/payment/consent resets and the React DOM input-event initialization blind spot.

## Decisions

Retain opaque input revisions, latest-request correlation, explicit read-only refresh and
server-owned policy. Narrow the revision to data actually used by the qualified quote schema.
Ordinary name/document corrections leave the displayed quote, payment choice, consent and
unconsumed CAPTCHA intact. The default fixture has no personal pricing fields: filling the
required tourist details adds no quote-refresh step.

Additional `TouristField` entries can declare `priceAffecting: true`; the versioned schema can
explicitly allow base `dateOfBirth` or `citizenship` through `priceAffectingBaseFields`. Nothing
is implicitly price-affecting. Full name, contacts and document type/series/number cannot be
selected through the base pricing whitelist. Real additional fields remain TOUR-80/84 input.

`QuoteRefreshRequest` carries participant count and an optional pricing-only projection. No
`BookingDraft.passengers` or `bookingPassengers` call is used for quote refresh. Unqualified
schema sends count only. Additional fields must be explicitly selected by the schema; form data
cannot promote its own fields. This is a UI port, not A's final transport DTO or legal approval.

For qualified text/date inputs, typing temporarily blocks submit and cancels an outstanding
refresh, but keeps the current quote/selection visible. Blur commits one material change and
invalidates the quote/choice. Select changes commit immediately. Returning to the same trimmed
value does not invalidate. Submit also checks the pricing snapshot, so Enter/programmatic submit
cannot send a stale revision while the field still has focus. Add/remove always invalidates.
Replies to cancelled/replaced requests are ignored, including during pricing-field typing.

PD/legal confirmation is keyed only to session and document refs/hashes. Pricing inputs and
tourist-schema identity no longer remount it. Changed legal versions reset it; unchanged legal
versions preserve it across refresh. The adult declaration separately resets on add/remove,
because it asserts the composition of the group, and on any actual DOB change independently of
priceAffecting. A DOB correction clears only that declaration; it does not revoke PD consent or
invalidate non-price quotes/payment choices. Ordinary document/name edits reset neither.

`bookingDraft` requires the current input revision explicitly; there is no trusted-view default
that could silently bypass the correlation guard.

## Test environment

`lib/test-support/dom-setup.ts` installs browser globals before importing React DOM. The input
regression asserts React `onChange` receives every character, using the native value setter and
bubbling input events. Checkout regressions use the same typing helper for full name, document
number and a synthetic qualified pricing field. Tests separately verify unchanged price/choice/
consents, blur-only invalidation, minimal refresh DTO and old late-response/UNKNOWN fences.

## Activation requirements

Before connecting real data, A and TOUR-80/84 must establish the purpose, necessity, minimum
representation and legal basis for every pre-consent pricing input. Prefer a less identifying
category when sufficient. A schema flag does not establish that basis; do not enable fields
just because the UI can render them. The default synthetic schema enables none.

`inputRevision` is untrusted client correlation data, not evidence of quote content. When issuing
a real quote, A must durably bind its identity to the admitted participant count, canonical pricing
inputs (stored values or a server-computed digest), pricing schema and pricing/policy versions.
On booking submission A must independently project the draft's actual passengers using that
qualified schema and compare them with the stored quote inputs. A mismatch, even with the same
client revision, must return definitive `QUOTE_STALE` without creating a booking/hold. While no
pricing fields exist, compare participant count; this binding is mandatory before the first
priceAffecting field is enabled. Server validation of every passenger's eligibility/age remains
mandatory; a checked adult declaration is not an age-verification result.

TOUR-80/84 must coordinate schema and PD document versions: adding a new category of personal
data requires a new pdConsent ref/hash covering that category and its qualified processing basis
before the schema is activated. Publish/bootstrap the corresponding versions together; never
add a category while retaining an older consent version that does not cover it. Presentation-only
schema changes need not reset consent when categories/purposes/basis remain covered. The UI
already resets consent when the document identity changes.

The UNKNOWN instruction against resubmission applies across reload/tab only after A supplies
durable owner-scoped session bootstrap, authoritative recovery and atomic idempotency. These
are mandatory activation conditions. The local synthetic lab resets on reload and does not
prove durable recovery. No native activation, deploy, task closure or custody change follows.
