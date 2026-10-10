# ART-47 slice 3c design

Slice 3c adds only the post-booking confirmation channel, abuse controls on new bookings, and a
visual integration of the existing customer flow. It does not add ЕИС state, deploy production,
configure Refref Business, publish DNS, or send a real payment.

## Confirmation email

`PAID -> FULFILLED` and insertion of one `BOOKING_CONFIRMATION` row happen in one Postgres
transaction, after Refref accepts the idempotent fulfilment acknowledgement. A unique
`(order_id, type)` constraint makes the side effect exactly-once locally. The request that observes
payment never calls Notisend.

The provider is Notisend (owner decision of 2026-10-08, which replaced the provider this design was
first written for). A worker claims due rows with a lease and `FOR UPDATE SKIP LOCKED` every ten
seconds. Notisend acceptance records the message `id`; a definitive refusal (4xx, or a `skipped` or
bounced recipient) becomes `ATTENTION`. Notisend's send API has no idempotency key, so a send is
repeated only when the message provably was not queued: HTTP 429 after the provider's delay, or a
connection that never opened, for at most 10 attempts. Transport, timeout (including HTTP 408),
5xx, an unreadable success and an expired lease are ambiguous and become `ATTENTION` without another
send. The stable outbox key travels as the `X-Mikluha-Outbox-Key` header for manual reconciliation
in the Notisend log. The message is transactional and contains no
unsubscribe mechanism. It sends only the recipient email, order number and protected order URL;
tourist and identity-document data never enter the provider payload or logs.

Fulfilment creates a 256-bit document-access token, stores only its hash on the order, and places the
plaintext token in the pending outbox row only until Notisend accepts the message. The protected
link exposes the order's exact stored offer and Заявка from any browser. This provides reliable
access to the frozen contractual documents without sending those personal documents through the
email provider. The message warns the customer not to share the bearer link; the application never
logs it and sends a no-referrer response.

Because the protected URL is a bearer credential to passport-bearing contract data, slice 4 must
also verify that live Coolify/Traefik access logging does not retain the token or unredacted path.

## Frozen legal content and release coupling

Every new order stores the authoritative offer text as well as its reference and hash. Payment
recomputes the text hash and fails closed if it no longer matches. The order page shows this stored
copy before payment and after fulfilment rather than substituting the current public page.

`/identity` publishes both offer and PD-consent references and hashes. Slice 4 must deploy the legal
pages and commerce from one admitted source commit, then verify that these four values describe the
public `oferta` and `soglasie-pd` pages before opening sales. Publishing either side independently is
not allowed: commerce must never record an older legal version than the page the customer saw.

## Booking throttling

Only an `X-Forwarded-For` value containing exactly one syntactically valid IPv4 or IPv6 address is
trusted (one Coolify/Traefik hop). Missing, malformed, and multi-value headers share one
`untrusted-ingress` bucket. New booking attempts also use a hashed normalized-email bucket as a
non-IP boundary. Both are fixed-window counters with expired-entry eviction, reserved shared
buckets, and a hard maximum number of per-IP/per-email entries. Exceeding either boundary returns
429 with `Retry-After` before an order can be inserted. The existing strict form validation,
8-KiB body limit, capacity transaction and sales switch remain independent controls. SmartCaptcha
is not part of launch.

## Customer pages

The server-rendered pages use the public site's warm paper, terracotta, blue and green palette,
rounded cards, typography scale, focus states and responsive form grid. No client script or
third-party asset is introduced; the existing restrictive CSP and no-store/noindex policy remain.
