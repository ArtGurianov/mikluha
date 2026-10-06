# Manual ЕИС filing and first-sale evidence

This runbook is for the operator after an order has a read-back-proven payment. Commerce does not
submit to ЕИС and must never be described as having done so.

## Safety boundary

- Use the root-owned `0600` `/etc/mikluha-commerce/operator.env`; never the service's runtime URL.
- Run the command in a one-off container from the exact deployed commerce image and network.
- `eis packet` prints passport-bearing personal data. View it only in the operator's local terminal.
  Do not redirect it to a file, shell history, CI, GitHub, Linear, chat, or a foreign service.
- If any stored fact differs from the ЕИС form, stop. Do not record `EIS_SUBMITTED` until the ЕИС
  filing is correct.
- Reasons are operational evidence and must not contain names, passport data, contacts or bearer
  tokens.

Prepare the command in the same way as the sales-switch command:

```bash
C=<service-container>
IMG=$(docker inspect -f '{{.Image}}' "$C")
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$C")
eis() { docker run --rm --network "$NET" --env-file /etc/mikluha-commerce/operator.env "$IMG" node dist/bin/eis.js "$@"; }
```

## One paid order

The legal transmission deadline is the 15th of the month following contract conclusion, but not
later than the trip starts. Our internal target is **24 hours before departure** to allow
corrections; it is not a claim that the ЕИС statute itself sets that 24-hour deadline. For a sale
in October for `altai-1` on 29 October, the trip-start limit takes precedence. The separate duty
to deliver travel/transport/accommodation documents is not fulfilled just by recording ЕИС state.

1. Confirm Refref read-back and commerce show the real order paid/fulfilled. Record only non-secret
   evidence: deployed source commit, order reference, payment evidence reference and timestamps.
2. Confirm commerce created the filing obligation:

   ```bash
   eis status <mk-order-ref>
   ```

   It must say `EIS=EIS_PENDING`. Absence or another state is a stop condition.
3. Open the ЕИС personal account. In a separate local terminal, display the stored facts:

   ```bash
   eis packet <mk-order-ref>
   ```

   Keep the displayed `eis_material_revision` in view; do not copy the packet elsewhere.
4. Compare every value against the ЕИС form before submission: order/departure and trip dates,
   price, customer contact, every tourist's ФИО/date of birth/citizenship/document, and the frozen
   Заявка/hash. Correct mismatches at their source; never edit only the evidence state.
5. Submit manually in the ЕИС personal account. Copy the actual electronic-voucher number returned
   by ЕИС, then record the external fact explicitly:

   ```bash
   eis submit <mk-order-ref> --number '<actual-electronic-voucher-number>' --revision '<eis_material_revision>' --by '<operator>' --confirmed-in-eis-lk
   eis status <mk-order-ref>
   ```

   The read-back must say `EIS=EIS_SUBMITTED` and show the same number. `EIS_PACKET_STALE` means a
   material fact changed after review: print and compare a fresh packet before doing anything else.
   `EIS_VOUCHER_NUMBER_OWNED` means that number is already lifetime evidence for another order: stop,
   verify both order references in the ЕИС personal account, and never work around the refusal.
6. If ЕИС later needs a correction, or the operator discovers an external mismatch:

   ```bash
   eis needs-update <mk-order-ref> --by '<operator>' --reason '<why>'
   ```

   Update the filing in the ЕИС personal account, compare the packet again, then run `eis submit`
   with the current actual number and fresh packet revision. Contract or tourist changes in the
   database mark this state automatically.

## First-sale evidence checklist

The evidence comment may contain only:

- deployed immutable source commit and exact schema head (7 after migration 0007);
- order reference and Refref payment evidence reference (no receipt contact or tourist data);
- `EIS_PENDING` read-back timestamp;
- operator confirmation that all stored contract/tourist fields matched the ЕИС form;
- actual electronic-voucher number, `submitted_at`, `submitted_by`, and operator database login;
- final `EIS_SUBMITTED` read-back;
- confirmation that no filing packet, passport data, bearer document token, or secret entered logs
  or the evidence comment.

ART-293 remains open until the real order completes this checklist. Slice 4 separately gates legal
release parity and redaction/exclusion of `/documents/<token>` in live Coolify/Traefik access logs.
