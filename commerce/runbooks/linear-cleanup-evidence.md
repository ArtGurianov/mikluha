# Completed Linear evidence boundary

This record preserves durable distinctions before completed Linear items are removed.

- ART-45: static public website and isolated merchant backend were deliberately retained rather than converting the site into a mutable monolithic commerce service. See `docs/DECISIONS.md` §9 and `commerce/README.md`.
- ART-46 / ART-248: Mikluha owns customer/tourist identifiers and statutory booking data locally. Refref receives only the minimum commerce/fiscal information for the active payment connection; on the real PROVIDER path the buyer's **receipt email** may be transmitted for fiscalization. Never interpret old MERCHANT-canary wording as banning the receipt contact required in the real production route.
- ART-251: the original manual Alfa refund + separate Ferma receipt instruction was superseded by tested Refref → Alfa/OFD refund receipts; it is not the default production refund process.
- ART-43 / ART-44: completing infrastructure and real payments/refunds in a canary is not permission to open public sales. Booking, legal documents, EIS requirements, PD agreement, operator admission and the launch runbook remain independently gated.
- ART-246 / ART-250: special historical receipt correction is recorded in `commerce/runbooks/fiscal-incidents.md` and must not be reused as a normal booking fiscal method.
