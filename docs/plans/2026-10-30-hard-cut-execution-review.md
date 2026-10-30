# Mikluha hard cut — accepted clean-slate replacement

The OWNER decision on 2026-10-30 supersedes the former review revisions 1–4.
Canonical current decision: [clean-slate owner decision](../decisions/2026-10-30-clean-slate-owner-decision.md).
Historical revisions remain in Git/private review evidence, not active gates.

1. Inventory exact Mikluha-only obsolete resources and protect shared neighbors.
2. Remove legacy DB/runtime/stand-in/writers; preserve compact evidence, not a
   running old stack. Use maintenance; no Sveltia/static fallback.
3. Develop only SSR + Control Room + native Commerce on a clean schema, with
   ZERO_IMPORT and direct S3; preserve versioned legal publication.
4. New DB automatic backup plus one isolated restore before real data entry;
   verify actual public/Admin flows and sales CLOSED. Full PITR/external-device
   qualification belongs before sales. Overall VPS drift is not a cutover gate.

Fresh source/image/schema/role and changed-resource checks remain; no repair of
unrelated VPS-16 drift, legacy migration/recovery, or new planning round is
required. Real sales/financial activation remains a separate owner decision.
