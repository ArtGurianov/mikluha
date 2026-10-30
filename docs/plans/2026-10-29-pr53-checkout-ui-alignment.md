# PR #53: checkout UI consumer review and alignment

Review target: merged `6487e07dfda0de7c4bbb3d8c366c43f6f658f67a`, compared with
`5e2e2d01255bbf646a601d8cf2e9214a30f57ded`. PR head before squash was
`e431c447b138af8e075f99412e444b1de78cf014`. The six changed Markdown contracts were inspected,
including the new canonical [MK-POLICY-v2.4](../refref-v10/06-mk-policy-v2.4.md) and downstream
booking/legal/integration/migration/README changes. The source is merged, not deployed or legally
published. TOUR-75 is Done for the accepted contract; TOUR-80/84/91 remain separate open inputs.

## Findings against the previous UI

| Contract | Previous UI gap | Source correction |
| --- | --- | --- |
| §1/5: fixed per-person deposit, full option, independently priced lines | One price label "per tourist" and a single payment paragraph; no choice, no quote identity | Server-supplied line prices, purchase total, deposit/full options, remaining amount and due label. No client multiplication, division, discount or deposit-cap calculation. |
| §1: deposit before T−72, full to T−24, catalog timezone | No visible deadlines or phase-specific options | Server supplies exact cutoff labels/timezone and allowed options. The browser neither computes eligibility nor opens a bank window. |
| §2: immutable terms/intent and no duplicate window | Draft lacked the quote/payment-choice identities | Command includes quote ref/hash and allowed option ref; user chooses explicitly. Changing quote ref/hash clears that choice. No amount/hold TTL/payment-owner field is accepted from browser noise. |
| §4: several adults in first booking; children manager-only | Multi-adult form was already correct, but no clear family route | Preserve initial adult group. Add explicit manager route for one accompanied family booking. Do not add birth-certificate/guardian public self-service or promise paid-booking additions. |
| §7: uniform extended dataset; legal/EIS qualification separate | Fixed field set and unconditional "needed for EIS" assertion | One versioned tourist schema with explicit extra-field descriptors and a whitelist for additionalDetails. Remove universal EIS-filing assertion. Unready schema blocks sending. |

PR #53 does **not** define a final list of additional EIS field names/types. Existing explicit
fields remain FIO, DOB, citizenship, identity type/series/number, plus separate buyer phone/email.
It would be incorrect to invent mandatory sex, birth place, issuing authority/date, address or
guardian fields from general assumptions. TOUR-80/84 supply the qualified uniform schema and
legal/privacy admission; those are not satisfied by a rendering component or `ready` flag.

## Presentation port, not a new backend contract

`BookingPresentation.quote` carries immutable ref/hash, quoted party size, individual line labels
and amounts, total, and currently offered first-payment choices. `schedule` supplies exact labels
and the source IANA timezone. `touristDataSchema` supplies ref/hash, completeness, and text/date/select
extra-field descriptors. These are client composition types; Agent A's actual HTTP API remains
unfrozen here. Its adapter must obtain/validate trusted quote/schema data and legal admission.

`BookingDraft` adds only quote/schema identities, selected payment option and the schema-declared
tourist values. It does not carry prices, discount allocation, client-calculated due dates, a profile,
bank URL or seat release instruction. Server validation remains mandatory; a valid browser form
or CAPTCHA callback is never authoritative evidence of admission, money or capacity.

After adding/removing a tourist, the form preserves existing inputs but clears payment choice and
CAPTCHA proof, notifies `onPartySizeChange`, and blocks sending against a quote for another party
size. It hides outdated prices rather than leaving a believable old total beside the new party.
The host obtains a refreshed quote and supplies it as a new presentation. The buyer must select
again; changing only the quote hash also invalidates selection. Legal checkboxes remount if their
document identity or party changes, preventing old confirmations from silently carrying forward.

All departures consume the same qualified tourist schema, not one public profile per transport,
lodging or EIS duty. Extra values are nested under `additionalDetails`, whitelisted by schema key,
and bound to schema ref/hash. Unknown browser/autofill/query fields are ignored. No tourist data
goes into CAPTCHA options, Refref, browser persistence or logs.

## Synthetic review cases and validation

The development lab selects **fixed quote fixtures**, not a local pricing policy: deposit/full;
full-only; closed; incomplete schema; and 4,000 RUB ticket + 2,000 RUB add-on with actual 4,000 RUB
deposit. Group fixtures deliberately contain unequal ticket prices. Add/remove selects another
predefined quote response. No client T−72/T−24/5+30 timer or server seat policy is implemented.

Tests cover quote/schema identity whitelisting, unsupported deposit refusal in full-only/closed
states, stale-party quote refusal, preserved inputs, fresh selection after quote/hash change,
declared required extra fields, group adults and manager-only child wording. Existing CAPTCHA,
UNKNOWN and duplicate-submit regressions remain. Browser checks use synthetic data at desktop and
mobile widths; builds must still exclude the lab.

Server/provider/EIS E2E, bank-window guarantee (TOUR-91), publication of the new offer, family
documents and actual mandatory EIS field qualification remain NOT_RUN/open. No Commerce SQL,
public route, legal artifact or deployed host changed. `CUSTODY_IMPACT: NO` for this alignment;
PR #55 retains its earlier YES/PENDING credential-copy receipt under VPS-18.
