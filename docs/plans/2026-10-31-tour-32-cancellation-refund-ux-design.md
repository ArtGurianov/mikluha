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
  whitelist: order reference comes from the server-supplied view; the customer contributes the
  applicant's full name (Заказчик of record), the chosen still-cancellable tourists, a reason
  category + free text, a reply contact, a policy acknowledgement and a CAPTCHA proof. No amount,
  percentage, retained-cost figure, card/bank detail, promo, partner or autofill field is ever
  forwarded; selections the server does not report as cancellable are dropped. **The scope is
  never read from arbitrary form input:** a whole-booking request exists only where the view sets
  `wholeBookingOnly`, so a forged `scope=whole` field cannot widen a per-tourist refusal into the
  whole booking. Server-side scope and eligibility checks remain mandatory regardless.
- `components/booking/cancellation-request.tsx` — `CancellationRequest`, a client composition
  port. No fetch, refund execution, bank redirect or partner claim lives here. A server-supplied
  money summary (paid / deposit / balance / retained expenses / indicative refund) is shown
  read-only alongside the request; indicative figures are framed as a voluntary offer, not a
  guaranteed amount. The public write reuses the Flexperiment `SmartCaptcha` exactly as checkout
  does. Submission fails closed; `UNKNOWN` blocks resubmission because the request may have been
  received; every non-`UNKNOWN` refusal proves nothing was executed. The interactive lifecycle
  (status, notice, consumed proof, in-flight guard) is bound to a stable `clientRequestId:orderRef`
  key, so a genuine change of session/order remounts the form and resets that lifecycle instead of
  carrying a prior `received`/`unknown` state across to a different application; a same-identity
  refresh only picks up new money/participants and prunes selections the server no longer allows.

### `received` contract

`received` means only that the application was durably registered with its receipt date/time and a
stable обращение reference; it is **not** proof of the legal moment of refusal, the refund amount,
or an executed refund. The server is expected to store the original refusal scope and the effective
redaction of applicable terms, and re-delivery of the same `clientRequestId` must not create a second
application. Establishing the applicant's identity against the contract (including when the reply
contact differs from the original) is the backend's responsibility; this UX only collects and labels.
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
documents go to `refunds@mikluha-maklai.ru`, not the form. Per «Как отказаться» the application
carries the order number (from the view), the applicant's full name (Заказчик), the affected
tourists and a reply contact; the response-time copy stays an effort ("стремится сообщить … не
позднее пяти рабочих дней"), not an unconditional promise, and does not shorten the statutory refund
term. The form refuses to collect passport scans, full card numbers or bank codes, and states that
sending the request neither charges nor refunds money and that refunds return through the original
qualified payment chain within the statutory term.

## Validation

- `pnpm run test` — 136 pass, including the cancellation suite: composer whitelist and the
  forged-`scope` guard, cancellable-selection binding, whole-booking and nothing-cancellable
  states, fail-closed markup, indicative-vs-final framing, and jsdom interactive tests for a single
  in-flight submit, fenced `UNKNOWN` resubmission, a locked `received` state, rejection input
  retention needing a fresh proof, `not_dispatched` retry, `refresh_required`, and the
  session-remount reset.
- `pnpm run lint` — clean.
- Staging `next build` — compiles, TypeScript passes, preview route excluded from production.

Not run / not owned here: real SmartCaptcha traffic and CSP, server verification / replay
protection / idempotency, order identity resolution, actual refund execution and Refref reporting.
Those remain TOUR-27 and the deferred partner-claim work. No deployment or sales activation is
authorized by this source.
