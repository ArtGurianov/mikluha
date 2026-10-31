# TOUR-67 runbook revision 3 · 2026-10-30

Runtime/source baseline: PR #62 `ddd7f893915a7892ee62f7a6537feb5eca784848`.
CUSTODY_IMPACT: NO — docs only; domain NO-GO, sales CLOSED, legal NOT PUBLISHED.
Repository visibility checked directly: Mikluha PUBLIC; infrastructure PRIVATE.

## Keep from original plan

Separate disposable acceptance/clean working DB; exact images and crypto/role
restore; independent encrypted off-host backup/GET/restore; qualified SSR rollback;
exact OWNER-approved body hashes; explicit installation and synthetic cleanup GO.
No PITR, legacy restoration or unrelated whole-host acceptance gate is added.

## Adopt from alternative plan

| Change | Impact tier | Reason |
| --- | --- | --- |
| Separate Phase A access/media recovery from Phase B payload erasure | critical fix | Current code implements disable/session revoke/media withdrawal, but no general content-history anonymisation. Do not invent an executable erasure path to pass Phase A |
| Open TOUR-94 before real third-party content entry | critical fix | Published/revision/audit immutability preserves personal payloads; real organizer/review/contact/image entry remains NO-GO until supported disposal and post-backup replay qualify |
| Move primary provenance to PRIVATE infrastructure | critical fix | PUBLIC application Git must not accidentally expose chat identifiers; keep only exact private link and SHA-256, with truthful public access label |
| Publish from a fresh branch without earlier local draft commits | material improvement | Deleting a file in a later commit leaves its identifiers in ancestors. Old drafts remain local/unpublished; the clean branch starts at the existing PR #62 base |
| Direct Cloud.ru CDN PDF link | minor enhancement | The recorded HTML URL returned 403, while the official PDF was actually read. Use the verified source in the runbook |

## Reject from alternative plan

Do not describe Phase A as containing no personal data: Admin logins/audit and
approved legal identifiers are still actual processing. TOUR-93 must establish
ongoing necessity, access and retention for that limited scope. Disable is not
erasure. If already-required disposal of Phase A data cannot be fulfilled,
that specific admission remains NO-GO; splitting the gate is not a policy waiver.

No migration allowing changes to immutable revision history is pre-approved.
TOUR-94 must design the actual controlled operation, lawful holds, attestation/
hash semantics and independent restriction replay. An old digest alone does not
prove anonymisation; legal/payment evidence is not an arbitrary deletion target.

## Conflicts / decisions needed

This revision changes the planned admission sequence: full content-payload erasure
moves to the separate Phase B gate. It does not authorize real entry or installation.
Before execution, present exact infrastructure resources/digests/secret authority,
backup schedule/retention and synthetic cleanup scope under separate OWNER GO.
The current UI does not automatically enforce the phase split; access and the
two legal-slug allowlist must be controlled operationally in the private contour.

## Risk delta

Makes the initial synthetic recovery test executable with existing operations,
keeps actual personal-content disposal open, and prevents public leakage from
new Git history. No host/provider/DB state is changed. Approved public texts are
unchanged and no publication or full privacy-erasure PASS is claimed.

## Revised merged plan

[Runbook revision 3](../runbooks/2026-10-30-ssr-admin-operational-acceptance.md):
scoped preparation → authorized disposable Phase A qualification → clean working
DB/own backup+restore and TOUR-93 scoped review → two approved legal publications.
Real third-party content requires [TOUR-94](https://app.plane.so/art-workspace/browse/TOUR-94/)
and the full 2.3-B restore/reconciliation proof before entry, including drafts.

Primary OWNER provenance is referenced through
[public reference metadata](2026-10-30-ssr-admin-owner-approval-reference.json),
not copied into this PUBLIC repository. Other unchanged legal/sales gates remain.
Validation: source review, repository visibility read-back, exact approved body
hashes, reference-file SHA-256, relative links/JSON, public commit ancestry/content
privacy check and diff whitespace. No runtime/provider tests rerun for docs only.


## Admission-review follow-up

Material improvement: Phase A working DB creates only necessary OWNER accounts.
EDITOR capability tests stay on disposable synthetic accounts; a real EDITOR is
not enrolled until confirmed need and Phase B admission. This narrows operational
access without claiming an API-level kind restriction or changing approved text.

CI run 41089176031 on 41e2405 was independently read back as 5/5 SUCCESS.
That result does not transfer to a later docs commit. PR #62 and private PR #20
are still OPEN at this check; no merge/retarget or receipt-link rewrite has been
performed. Merge #62 first under separate authority, then retarget #63 to main,
check its remaining diff/CI and merge only with authorization. After private
#20 merge, pin the receipt URL to its exact main merge commit and recheck the
same file SHA-256; a moving main URL weakens the reference.

Tracking: created TOUR-95 for actual Phase B content admission. TOUR-94 blocks
TOUR-95 through a built-in dependency; TOUR-67/68/93 are related rather than
blanket-blocked. This preserves the independent limited Phase A path.
