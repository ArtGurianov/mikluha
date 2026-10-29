# Flexperiment SmartCaptcha port

`flexperiment-smartcaptcha.tsx` is copied from
[`ArtGurianov/flexperiment/apps/lab/components/SmartCaptcha.tsx`](https://github.com/ArtGurianov/flexperiment/blob/be55bb755100535fd2af5f2a407b1be0199e2c40/apps/lab/components/SmartCaptcha.tsx)
at source snapshot `be55bb755100535fd2af5f2a407b1be0199e2c40` (the file's last change is
`126d5f6fb397104654812a71d260291531b06ffa`). Flexperiment itself is unchanged.

The script loader, singleton promise, `onToken` / `resetKey` API, mount-only loading,
Russian widget rendering, reset, subscriptions and destruction are reused. Mikluha's previous
`lib/smartcaptcha-widget.ts` implementation is removed. Checkout-specific copy, retry and
one-use submission handling belong to the wrapper, not a parallel SDK implementation.

Small local changes from upstream:

- Export the SDK interface for DOM tests.
- Ignore callbacks after disposal and success after a fatal SDK error until explicit reset.
- Use Mikluha's existing text colour and retry wording.

Keep these differences small when refreshing the upstream copy. The client consumes only
`NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY`. Never add a server key or validation request here.
Flexperiment's server counterpart is `commerce/src/smartcaptcha.ts`; actual Mikluha verification,
replay protection, admission and hold policy remain Agent A's integration scope.
