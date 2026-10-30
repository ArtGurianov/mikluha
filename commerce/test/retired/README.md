# Historical checkout test harness

These retired Refref/arrival/HTML implementations preserve prior financial, consent, refund,
legal and stop-sales test evidence. They are **not a supported transport**. Only tests import
this directory. TypeScript compiles `src/` only; Docker copies `src/` only; the root Docker
context excludes `commerce/test`. Production has no Refref client, handoff route or worker.
Current public transport retirement is tested in `retired-checkout.test.ts`.
