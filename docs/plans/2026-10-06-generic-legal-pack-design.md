# Shared legal pack and booking application

Owner authorization: implement the shared legal pack and booking-specific application in one
non-stacked PR, and prepare the Refref processing instruction for signing. Base is Mikluha main
`9427c68aa010b68a9e8eb1f76c371ef799996f3d`. No deployment, production writes, signature attestation,
monitor admission, provider calls, sales opening, or Linear closure is authorized by this change.

## Design

Use the existing offer, separately versioned PD consent, and frozen order-document boundary.
Extend the existing CMS/catalog rather than introducing a document service. A departure may supply
its own complete product conditions (program, route, inclusions, exclusions, risks); if supplied,
they replace tour defaults as a whole. Incomplete overrides cannot fall back to another trip's
marketing/demo program. The Заявка binds those conditions, the departure, tourists, and resolved
price; changing any individual condition changes its hash. PD consent and the processor instruction
remain outside Refref's tourism `legalReleaseHash`.

Record the supplied `altai-1` dates, times, 26,500 RUB price and nominal capacity 40, CLOSED and
unlisted. Leave missing accommodation, day-by-day program, meal counts and address facts blank.
No newly supplied commercial fact is a launch admission. Online tourists remain adults only.

The owner selected documented actual expenses over the qualified full-only refund policy. Publish
that policy without fixed penalties, including the voluntary full refund at least five calendar
days before departure. Expense deductions/partial refunds are not implemented or qualified here.
An explicit code gate must refuse new reservations, payment initiation and production startup for
this policy, even if someone sets launchReady or opens the database sales switch.

Prepare a generic PD-REFREF-1 version 1.0 signing form and an unsigned database example. Never
invent signatures, signed dates, or signed-file hashes. Keep missing signatory/requisites explicit.
The signing form uses only payment email, pseudonymous payment/attribution identifiers and necessary
technical data; never tourist identity/passport data. Signed artifacts stay in the owner's Russian
evidence store. The draft/template is not PD-consent or signature evidence.

## Verification

Test whole-override behavior and incomplete override rejection, exact application content/hash
binding, explicit service inclusion, unsigned example state and role isolation, and fail-closed
unqualified-refund admission. Keep existing frozen-contract, consent, EIS and payment tests green.
Run site/commerce CI equivalents and rule-removal controls; record exact commit/counts in the PR.
Render the signing DOCX and inspect every page. A schema change is owner-applied only and requires
fresh post-migration recovery evidence before any subsequent production admission.
