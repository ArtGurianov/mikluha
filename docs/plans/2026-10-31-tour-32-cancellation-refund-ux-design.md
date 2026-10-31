# TOUR-32 / M6.5: customer cancellation & refund UX

`CUSTODY_IMPACT: NO` — source-only presentation components and a development-only review
route. No deployment, host state, credential, schema, network call or money operation is
introduced; sales remain CLOSED.

## Scope (current acceptance)

TOUR-32 owns the **customer-facing cancellation/refund request UX** for deposits, balances and
documented retained expenses. Explicitly out of scope and deliberately not implemented here:

- **Refund execution** — the qualified Mikluha→Refref→Alfa refund path is TOUR-27 / ART-263.
  This source never moves money, computes a legal refund, or decides eligibility.
- **Partner-reward / Refref claims** — deferred to TOUR-87 / N10. No commission, `C`/`E`
  threshold, bank-readback or claim logic appears. The copied v9 commission rules are removed:
  they are not customer UX and belong to the deferred partner-claim and backend-execution work.

All numbers are server-formatted labels. As in native checkout, the browser computes no refund
percentage, retained cost, balance or eligibility, and the published voluntary-settlement scale
(95/90/50/30/0 %) is never recomputed client-side — it is an offer, not a fixed penalty.

## Composition, mirroring native checkout

Same isolated-component pattern as TOUR-28/49 so the flow can be reviewed before an API exists:

- `lib/cancellation-request.ts` — presentation ports (`CancellationPresentation`,
  `CancellationDraft`, `CancellationOutcome`), the `cancellationDraft()` composer, and
  `selectedCancellableRefs` / `canRequestCancellation` helpers. The composer is an explicit
  whitelist: order reference and cancellation scope come from the server-supplied view; the
  customer contributes only the chosen still-cancellable tourists (or a whole-booking scope),
  a reason category + free text, a reply contact, a policy acknowledgement and a CAPTCHA proof.
  No amount, percentage, retained-cost figure, card/bank detail, promo, partner or autofill
  field is ever forwarded; selections the server does not report as cancellable are dropped.
- `components/booking/cancellation-request.tsx` — `CancellationRequest`, a client composition
  port. No fetch, refund execution, bank redirect or partner claim lives here. A server-supplied
  money summary (paid / deposit / balance / retained expenses / indicative refund) is shown
  read-only alongside the request; indicative figures are framed as a voluntary offer, not a
  guaranteed amount. The public write reuses the Flexperiment `SmartCaptcha` exactly as checkout
  does. Submission fails closed; `UNKNOWN` blocks resubmission because the request may have been
  received; every non-`UNKNOWN` refusal proves nothing was executed.
- `components/booking/cancellation-preview{,-data}.tsx` and `app/cancellation-preview/
  page.preview.tsx` — a development-only lab with synthetic data, adapter/scenario switches, and
  an opt-in to real CAPTCHA. The `.preview.tsx` leaf + `NODE_ENV` backstop keep it out of the
  production route table (verified: a staging `next build` lists neither preview route), exactly
  like `/checkout-preview`. It never calls Commerce, a bank or Refref.

## Alignment with the published rules

Copy follows `content/legal/otkaz-i-vozvrat.yml`: voluntary refusal is possible at any time;
only documented actual expenses directly tied to the cancelled part may be retained; per-tourist
cancellation is scoped to that tourist's obligation; special grounds (illness, safety threat,
operator inability) are handled by law and individual calculation, not the scale; supporting
documents go to `refunds@mikluha-maklai.ru`, not the form. The form refuses to collect passport
scans, full card numbers or bank codes, and states that sending the request neither charges nor
refunds money and that refunds return through the original qualified payment chain within the
statutory term.

## Validation

- `pnpm run test` — 131 pass, including 7 new tests (whitelist, cancellable-selection binding,
  whole-booking and nothing-cancellable states, fail-closed markup, indicative vs final framing).
- `pnpm run lint` — clean.
- Staging `next build` — compiles, TypeScript passes, preview route excluded from production.

Not run / not owned here: real SmartCaptcha traffic and CSP, server verification / replay
protection / idempotency, order identity resolution, actual refund execution and Refref reporting.
Those remain TOUR-27 and the deferred partner-claim work. No deployment or sales activation is
authorized by this source.
