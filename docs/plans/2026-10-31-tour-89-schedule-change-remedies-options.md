# TOUR-89 — organizer schedule-change: materiality, buyer remedies (options)

Status: **DECISION INPUT / OPTIONS FOR OWNER + LEGAL**, 2026-10-31. These are proposals requiring
OWNER/legal qualification, **not approved parameters**. No implementation, merge, deployment, legal
publication, bank/refund operation or public-sale authorization. Without an approved decision here,
the dedicated schedule-change stage [TOUR-92](https://app.plane.so/art-workspace/browse/TOUR-92/)
(child of TOUR-79) must not be implemented or accepted.

Provenance: [TOUR-89](https://app.plane.so/art-workspace/browse/TOUR-89/), separated from
[TOUR-75](https://app.plane.so/art-workspace/browse/TOUR-75/) / draft PR #53. Inputs:
[MK-POLICY-v2.4 §1, §9](../refref-v10/06-mk-policy-v2.4.md),
[booking-and-prepayments §5–§9](../refref-v10/02-booking-and-prepayments.md),
[fiscal/EIS/legal §2, §6, §8](../refref-v10/04-fiscal-eis-and-legal-impact.md). Legal input also
needed from TOUR-84.

## 1. Fixed premises (already decided, not re-opened here)

- The **published planned departure moment** is the operating clock for every cutoff and offer; there
  is no GPS/boarding/physical-departure telemetry and none is requested (policy §1). A schedule
  change is a change to that *published* moment, decided by the organizer.
- Changing the published schedule **does not rewrite prior accepts**: old accepted revisions,
  documents, prices and consent are immutable (policy §1, booking §2/§7, 0017 guards).
- A material change must flow through the same immutable-revision + consent machinery as other
  amendments (TOUR-79); no unilateral rewrite, automatic cancellation or retrospective default is
  authorized by TOUR-89 or TOUR-79.

The four decisions OWNER/legal must return: **(A) materiality threshold**, **(B) notice + consent**,
**(C) treatment of existing contracts and pending payments**, **(D) refund remedy on rejection of a
material change** — plus handling of unresolved buyers and newly-past-due dates.

## 2. (A) Materiality threshold — options

A change below the threshold = notice only; at/above = buyer consent right + rejection remedy (§5).

| Option | Rule | Trade-off |
|---|---|---|
| A1 — any date/day change is material; time-only within the same day is minor | Simple, buyer-protective, easy to evidence | May over-trigger the consent/refund path for trivial shifts |
| A2 — tiered by magnitude (**recommended starting point**) | *Minor:* departure-time shift ≤ a small bound, same calendar day, no lost connection/overnight/program element → notice only. *Material:* date/day change, time shift beyond the bound, or any change that breaks a connection, overnight, carrier or a priced program element | Needs an agreed bound and a defined list of "breaking" elements |
| A3 — any organizer-initiated schedule change is material | Maximum buyer protection, minimum ambiguity | Highest operational/refund exposure; treats trivial shifts as full consent events |

**On the numeric bound (P2):** the ≤6h transfer-proposal bound is an *offer TTL* for buyer-initiated
transfers — it is **not** automatically a materiality threshold for an organizer-initiated schedule
change, and must not be carried across by default. It is at most one candidate value to consider; the
materiality bound is a separate OWNER/legal parameter to be set and justified on its own.

Legal anchor to confirm the threshold against: PP RF №551 (eff. 01.09.2026) rules on changing
essential contract terms and consumer rights (fiscal §6). Rospotrebnadzor confirms that a change to
the travel *dates/timing* is among the material changes of circumstance. The numeric bound and the
"breaking elements" list are **OWNER/legal parameters**, not set here.

## 3. (B) Notice and consent — options

- **Notice channel:** the buyer's verified original email + manager contact (never a dead public
  link), mirroring the T−24 overdue notice rule (policy §3). Reminders recomputed against any new
  deadline the change creates; no late/duplicate messages; UNKNOWN payments accounted for (policy §3).
- **Consent mechanism (for material changes):** a secure, single-use, time-bounded link that records
  explicit consent **bound to the immutable candidate/revision hash**, exactly as the transfer/offer
  flow already does (booking §9.2, policy §6). A mail-robot scan of the link is **not** consent.
- **Consent options:**
  - B1 — explicit opt-in: the material change takes effect only on proven buyer consent to the new
    revision hash; silence ≠ acceptance (**recommended**; aligns with "no retrospective default").
  - B2 — opt-out with a qualified deadline: change takes effect unless the buyer rejects within a
    legally-qualified window. *Only* viable if §551/ЗоЗПП qualification confirms it and the window and
    its default are legally sound — otherwise excluded.
- **Timing:** consent window must end before the relevant planned hard-bounds; no executable payment
  link outlives the offer (booking §9.2).

## 4. (C) Existing contracts and pending payment instructions

- Old accepted revision/documents/prices preserved and independently reproducible; the change is a
  **new proposed revision**, never an edit of the old one (booking §7.1, 0017).
- **Pending/open payment instructions at the moment of the change:** no new instruction is issued on
  an overlapping, not-proven-unpaid scope while a prior operation is UNKNOWN; the bank/seat fence
  holds (booking §4, §7). A pending instruction is resolved by read-back before the new revision's
  money is opened; it is never silently redirected to the new schedule.
- **New deadlines:** recomputed from the new planned moment **without inventing a retrospective
  overdue** — a buyer cannot be in default for a deadline that only exists because the organizer moved
  the schedule (task acceptance; booking §9.1). Pure debt-deadline extension stays a binding
  append-only event, not a new revision (policy §1).

## 5. (D) Refund remedy when the buyer rejects a material change — options

All are **proposals requiring OWNER/legal qualification**; none authorizes a real refund.

| Option | Remedy | Notes |
|---|---|---|
| D1 — full refund of money actually received (**proposed commercial default**) | On buyer rejection of a material organizer-initiated change, offer a **full refund of confirmed receipts**, once each, via the qualified native Alfa refund scope, with fiscal/EIS correction and audit | Not a penalty, not a forfeited deposit; refund amount = proven receipts minus prior proven refunds (booking §8). D1 is a reasonable proposed commercial standard, but it **cannot yet be declared as automatically flowing from №551 for all Mikluha routes**: the consequences of changing/terminating the contract need separate civil-law qualification per offering (see §5 note) |
| D2 — buyer's choice: accept new schedule, accept an offered alternative departure (transfer flow), or full refund | Most consumer-friendly; reuses the TOUR-79 transfer machinery for the "alternative departure" branch | Larger surface; the alternative-departure branch must obey the existing 6h/transfer rules |
| D3 — refund minus independently-documented unavoidable costs | Lower organizer exposure | Highest legal risk for an **organizer-initiated** change; likely disfavoured by consumer law — include only if legal explicitly supports it |

Refund, service termination, retained documented expenses, fiscal action and EIS change are **distinct
facts** and must be handled separately (booking §8, fiscal §3). A certificate/internal credit is not a
bank refund.

**Legal applicability note (P1-adjacent):** the reference to PP RF №551 is apt, but its rules on
*realisation of a tourist product* must be **separately confirmed to apply to Mikluha's specific
bus-trip model** per offering (excursion-vs-tourist-product qualification, fiscal §5/§6). Rospotrebnadzor
confirms a change of travel dates is among material changes of circumstance, yet the *consequences* of
changing or terminating the contract are a separate civil-law qualification. So D1 is a sound proposed
commercial standard but is **not** to be published as an automatic №551 consequence for every route
until that per-offering legal qualification (TOUR-84) is done.

## 6. Unresolved buyers and no-response handling

The review (P1) is correct: "stays on the old accepted revision" alone does **not** close the
scenario, because once the organizer has moved the only departure, the service at the old planned
moment **cannot physically be performed**. Two facts must be kept separate:

- **Legal history (preserve):** the old accepted revision, its documents, price and planned moment
  stay immutable and reproducible. The unilateral change never silently overwrites them and the buyer
  is never auto-defaulted. This part of the original U1 stands.
- **Service performance (must be resolved):** preservation of the record is not performance of the
  trip. For an organizer-initiated material change the organizer is the party that can no longer
  perform the original, so a non-responder cannot be left in an undefined state past the point where
  a trip actually departs.

Proposed procedure (requires OWNER/legal qualification):

1. **Resolution deadline = the earlier of the original and the new planned departure.** A schedule
   change can move a trip *earlier* (e.g. 12 → 10 November), so "resolve before the original
   departure" is wrong — by the original moment the new, earlier departure has already left. The
   binding deadline for reaching a non-responder's decision is **min(original planned departure, new
   planned departure)**, bounded by both exactly as the transfer offer is bounded by both the source
   and target departures (booking §9.2, policy §6). Before that moment: repeated notice, direct
   manager contact, and a clearly stated consequence if no choice is made.
2. **Change proposed too late to resolve before that deadline.** If the organizer proposes the change
   so late that there is not enough time to obtain consent before min(original, new) departure, the
   addition/earlier departure is **not admitted for that buyer**: the buyer is **not** moved onto a
   departure they did not accept, and the organizer's inability to perform the original on its own
   terms triggers the §5 remedy (default D1 full refund, or an alternative departure the buyer can
   still accept in time). A too-late proposal never silently places a buyer on the new schedule.
3. **If consent is still not obtained by the deadline,** the organizer's inability to perform as
   originally agreed is the trigger: the case resolves into the §5 remedy the buyer is entitled to for
   an organizer-initiated material change (default: the D1 full refund, or an offered alternative
   departure), **not** a silent lapse and **not** a buyer default. The right to claim the refund
   arises no later than the organizer's own failure to perform at the agreed moment, subject to the
   civil-law qualification in §5.
4. **Capacity allocation.** A non-responder's seat stays reserved against resolution and is **not**
   resold until the case is resolved; equally, an unresolved seat is **not** counted as available on
   the *new* departure, so consenters and non-responders cannot be double-counted and the new
   departure is not oversold on the strength of seats that are still in limbo.

Rejected alternative — **U-bad:** leaving a non-responder "on the old revision" indefinitely, past
the original departure, with no resolution. This is the gap the review identified and is explicitly
**not** proposed.

- A material change can create **newly past-due** balances only against the *new* schedule; those are
  not retroactive defaults and must not trigger overdue notices for the old schedule.

## 7. Acceptance of this decision (what "approved" must contain)

1. A **versioned** decision record (version / hash / effective date / approver) — not a silent
   implementation default (booking §7, fiscal §6).
2. Explicit values for A (threshold + breaking-elements list), B (consent model + window), C (pending
   payment + new-deadline handling), D (refund remedy), and the unresolved-buyer rule.
3. Preservation of old accepted documents/prices guaranteed; no unilateral rewrite, automatic
   cancellation or retrospective default.
4. Criteria written so TOUR-79 / TOUR-92 (and the legal input in TOUR-84) can **consume** them before
   admitting any affected change; TOUR-92 stays blocked until this is approved.

## 8. Recommended default package (for OWNER/legal to accept, amend or reject)

A2 (tiered materiality, with the bound set and justified on its own — **not** defaulted to the 6h
transfer TTL) · B1 (explicit opt-in consent bound to the revision hash) · C as in §4 · D1 (full refund
of receipts on rejection, as a *commercial* default pending per-offering №551/civil-law qualification)
with D2's alternative-departure branch offered where a suitable departure exists · the §6 procedure
for unresolved buyers (resolve before the original departure; never an indefinite limbo). Every
numeric bound and the legal sufficiency of each remedy remain an OWNER/legal decision; this document
proposes, it does not approve.

---

## Review resolution (2026-10-31, PR #67)

- **P1 — U1 left a contract on a non-existent old departure:** §6 rewritten to separate preservation
  of the old accepted revision (legal history) from service performance; non-responders must be
  resolved **before the original planned departure**, and the organizer's inability to perform the
  original triggers the §5 remedy rather than an indefinite limbo; capacity rules keep unresolved
  seats from being resold or counted as available on the new departure.
- **P2 — 6h threshold:** §2 no longer carries the buyer-initiated transfer TTL across as a materiality
  bound; the materiality bound is a separate OWNER/legal parameter, and §8 no longer defaults to 6h.
- **Legal nuance:** §5 adds that PP RF №551's applicability to Mikluha's specific bus-trip model must
  be confirmed per offering, and that D1 is a proposed commercial standard, not an automatic №551
  consequence for all routes until the TOUR-84 qualification is done.

### Round 2 (PR #67, head after e6b34e9)

- **P2 — earlier-date transfer:** §6 resolution deadline is now **min(original, new planned
  departure)**, bounded by both; added an explicit path for a change proposed too late to resolve
  before that deadline (buyer is not silently moved; §5 remedy applies).
