# ART-47 slice 3b: customer-facing and legal cutover

## Scope

Slice 3b replaces the site's legacy QR/prepayment booking path with the separate
`mikluha-commerce` service. It publishes the launch legal documents, gives every
bookable departure a direct commerce URL, records a separate versioned personal-data
consent, and makes production content fail closed when a sellable departure is not
contract-ready or still contains explicit demo content.

Email, rate limiting and the booking-page visual redesign stay in slice 3c. Manual
EIS tracking and its operator workflow stay in slice 3d. Deployment, production
credentials, backups, monitoring and the first real payment stay in slice 4.

## Contracts and consent

The tourism contract remains the published offer plus the frozen per-order application.
Its `legal_release_ref` and `legal_release_hash` continue to feed Refref unchanged.

Personal-data consent is a different legal artifact. Commerce loads the published
consent document as a versioned reference and SHA-256 hash, shows an independent
required checkbox, validates the submitted reference and hash against the current
document, and stores the accepted reference, hash and timestamp on the order. It is
not included in Refref's commercial `legalReleaseHash`.

Payment fails closed unless the stored consent evidence still matches the artifact
accepted during booking. Updating the published consent affects new bookings but does
not rewrite evidence stored on existing orders.

## Site and content gates

Booking CTAs become normal links to the configurable commerce origin with the departure
slug in the query string. The modal/provider and all QR/prepayment/default-booking CMS
fields are removed. The public site remains a pure static export and collects no data.

With `launchReady=true`, every OPEN departure must have positive capacity and
the complete tour/departure contract shape accepted by commerce. Production validation
also rejects the explicit demo marker `Демо` in any sellable contract field, even when
`isDemo` was cleared.

The legal collection must contain the operator details, offer, privacy policy, payment
rules, full-refund launch policy, cookie policy, and personal-data consent. The privacy
policy names Refref and Alfa, explains the exact data flow and retention periods, and
states that live data and backups remain in Russia.

## Verification

Tests cover separate consent versioning and persistence, fail-closed payment, direct
booking URLs, removal of legacy fields, required legal pages, contract completeness,
and explicit demo-marker rejection. Each new invariant receives a mutation check in
the PR evidence, followed by the existing site checks, all commerce tests, and the
commerce image smoke build.
