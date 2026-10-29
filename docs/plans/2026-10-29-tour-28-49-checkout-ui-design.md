# TOUR-28 / TOUR-49: isolated native checkout UI

Agent B scope: buyer form and SmartCaptcha UX only. This source does not switch the public
booking path, implement Agent A's API, verify CAPTCHA server-side, allocate seats, expire holds,
create payment operations or authorize publication/deployment. `CUSTODY_IMPACT: NO` — local
source only; no host configuration, credentials or persistent resources change.

## TOUR-81 status checked first

On 2026-10-29, Plane still correctly has TOUR-81 In Progress. PR #50 is merged as `9c72ee4`
at head `4f8e7f06437460d86724e92f1c82bcd340921e45`; exact-head CI `40829002834` is 4/4 SUCCESS.
The issue's stale "NOT merged" description was corrected to match GitHub and its own merge comment.
S1 already supplies disabled promo/Apply and inert `/arrive`; it is not reimplemented here.
TOUR-76 is merged through #51, but its public `/orders` still uses legacy RC. TOUR-77 and TOUR-78
were Backlog at the check. TOUR-81 S2 native purchase/first-payment/outbox/restart qualification
remains open. A merge with `[skip cd]` is not a deployment or sales receipt.

## Choice and composition

Considered changing Commerce's current HTML form, static mockups, and isolated React components.
The isolated components allow interactive review without prematurely changing legacy checkout
or guessing the native API. They use the site's existing Manrope, warm paper, terracotta, blue,
green, rounded panels and responsive grid. A compact trip/first-installment summary sits alongside
the form on desktop and before it on mobile.

- `NativeCheckout`: contact details, tourist rows, legal consent, disabled promo, server notices.
- `BookingPresentation`: display strings and admitted document identities supplied by a future
  integration. No total, discount, balance, hold expiry or eligibility is calculated in the browser.
  `maxParticipants` is the form's party-size bound supplied by that integration, not seat availability.
- `submit(BookingDraft)`: client composition port, **not** a frozen HTTP contract. The whitelist
  includes tourist/contact/consent data and an opaque CAPTCHA proof. No price, profile, partner,
  promo, query/autofill extras, arrival or payment-owner field is sent.
- `SmartCaptcha` accepts a stable `CaptchaMount`. `smartCaptchaMount(publicKey)` is the real SDK
  adapter. The development lab injects a synthetic mount and in-memory submit callback; it has
  no Commerce, Refref, bank or CAPTCHA-provider connection.

No adapter means submission is disabled. Promo is an unnamed disabled input, disabled
`type="button"` Apply and an accessible reason with no future discount/partner promise.
An integration must compose these functions inside a Client Component; server-to-client props
remain serializable. Key the checkout by its immutable departure/quote/document context when
changing that context; never replace the presentation underneath an outstanding submission.

## CAPTCHA and failure UX

The real widget loads only on protected-form mount. Missing public key, script error or 12-second
load timeout fails closed in the UI, with an explicit retry. Network/JavaScript errors invalidate
the proof and ignore late success until the widget is remounted. Token expiry invalidates the proof.
Each attempt consumes the proof before awaiting the adapter; a definitive rejection remounts the
widget and keeps tourist/contact inputs in the current page. Tokens and input values are not
logged, persisted to browser storage, included in URLs or forwarded as widget parameters.

Loading and status text are announced, notices receive focus, inputs lock during submission,
and a synchronous guard prevents duplicate submits. A received reference means only "received",
not paid/confirmed. Exceptions and explicit UNKNOWN block further submission: the result may
have been committed. No automatic retry, bank navigation or fresh-order suggestion is offered.
"Rejected" is permitted only if the adapter proves no booking was created. `RATE_LIMITED` copy
asks the user to wait; it does not invent a server cooldown or hold timer.

The SDK contract was checked against [Yandex's official widget methods and events](https://yandex.cloud/en/docs/smartcaptcha/concepts/widget-methods)
and the existing Flexperiment `docs/smartcaptcha-operations.md` boundary. The browser success
callback supplies an **unverified proof**; it never proves server admission, inventory or payment.

## Local review and build exclusion

Run `pnpm install --frozen-lockfile`, `pnpm run sync:content`, then
`pnpm exec next dev --webpack --hostname 127.0.0.1 --port 3118` and visit
`http://127.0.0.1:3118/checkout-preview/`. Only synthetic data belongs in this lab.
Its controls exercise CAPTCHA loading/expiry/error/retry, adapter refusals, received and lost ACK.
"New session" is a test harness control, outside the buyer form.

The route is `page.preview.tsx`. `next.config.ts` recognizes that leaf extension only in
development, with a `notFound()` backstop. Production static and SSR builds therefore have no
preview route or synthetic client bundle. `validate:out` explicitly rejects an exported preview.
No public CTA points at the lab; current `/book`, `/orders`, `/arrive` and restrictive Commerce
CSP are unchanged. This source is not proof that native checkout is publicly integrated.

## Validation and remaining acceptance

Local validation: root tests, lint, route type generation/TypeScript, staging static build and
export validation. Browser checks cover 1440 px desktop, 390 px mobile without horizontal overflow,
disabled unnamed promo, proof expiry/error/retry, preserved input after rejection, one callback
for double submit, UNKNOWN blocking resubmission, add/remove tourist and missing adapter. SDK
lifecycle tests cover stale callbacks, pending-load unmount, error/retry and listener cleanup.

The existing `launchReady=false` blocks production-content validation as designed. Staging
validation leaves that gate closed. No new Commerce/API/database code changed; native HTTP,
provider, real CAPTCHA solve/expiry and bank E2E are NOT_RUN here.

Before integration, Agent A owns server verification/replay protection, durable idempotency and
UNKNOWN read-back, admitted quote/legal data, native payment routing and all hold/seat policy.
Agent D owns concurrency/flood/replay/TTL negative E2E. Qualify actual SmartCaptcha traffic/CSP,
privacy disclosure and no tourist-data leakage in the selected renderer. Do not relax the current
Commerce CSP merely to mount this component. TOUR-28, TOUR-49 and TOUR-81 remain In Progress
until their full integration and independently gated acceptance is complete.
