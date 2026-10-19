# PR #40 independent review and corrections

Reviewed head: `ff53144a41a55d19461242563e67a22f7b3cff06`.
Comparison base: `6019fb216bcf5897e6831817979bac06842b1874` (`origin/main` at review time).
Scope: the 16-file PR diff, migrations 0008/0009, SQL permissions, editorial/public consumers,
mail worker integration, ADR v2.3 §2–§4, tests and recovery documentation. The supplied draft review
was treated as a list of hypotheses; regression tests were run against the unchanged migration
chain before implementing corrections.

| Draft finding | Independent result | Correction / remaining obligation |
|---|---|---|
| P1: repeated MATERIAL creates duplicate work | Confirmed. `0009:660–674` inserts a new change/event without advancing either expected-version token. Concurrent requests serialize but both succeed. The same draft can subsequently publish as EQUIVALENT. | Migration 0010 adds unique `(departure_id, from_version, draft_revision)` identity, returns the original MATERIAL result under the departure row lock, and rejects changed notice/classification with typed `EXECUTION_CHANGE_CONFLICT`. Replay uses recorded affected orders even after reservation expiry. |
| P1: hidden organizer leaves departure public | Confirmed. `0009:791–806` filters organizer rows but not their dependent departure. | Migration 0010 hides the entire departure when any linked organizer is unpublished/unlisted. Published but hidden organizers remain valid editorial relations; public visibility waits for the complete graph. |
| P2: delivery-report ingestion is absent | Confirmed integration gap. `recordNoticeDelivery` has no runtime caller; its direct test is not proof of provider ingestion. | README explicitly requires verified source and `provider_job_id` correlation in ART-365. Until then ACCEPTED remains ACCEPTED; Control Room cannot imply delivered mail. No webhook/status consumer is claimed here. |
| P2: SQL does not prove OWNER authorization | Confirmed boundary. `admin_app` is a service role, and the actor is caller-supplied text. | README requires live OWNER-session authorization and a persistent authentication-to-audit link in ART-363, exercised via the ART-365 API integration. This patch does not invent a new database authentication system. |

The dependency trace also found that `public_report` independently tested only its departure's
raw listing flag. Fixing `public_departure` alone would leave reports exposing a hidden dependency.
Migration 0010 therefore resolves linked-report visibility through `public_departure`; tour-only
reports remain visible. Tests cover two organizers (one hidden), later unlisting/relisting, and
saving a hidden draft without publication.

## Validation

- Before the fix: the original 20 content-CRUD tests passed; all five new behavioral regressions
  failed, reproducing duplicate changes, concurrent reclassification and both visibility cases.
- After the fix: `pnpm run typecheck`, `pnpm run build` and all **163/163 commerce tests** passed
  against a disposable local PostgreSQL **16.15** server, with matching PostgreSQL 16 dump/restore
  clients. The initial local run using PostgreSQL 18 clients failed its restore; it was rerun with
  matching tools rather than skipping or weakening the restore check.
- A populated schema-9 database upgrades through migration 0010, preserving all 1–9 migration
  records/checksums and published revisions. Reapplying migrations is a no-op.
- The logical restore test replays a pre-dump MATERIAL operation, refuses EQUIVALENT for that
  identity, rejects a duplicate at the restored unique constraint and verifies one order event.
- Migrations 0008 and 0009 are byte-identical to the reviewed head. `git diff --check` passed.

The correction is a forward migration because applied migration checksums are immutable. An
existing schema-9 database with duplicate classification identities needs a separately reviewed
history-resolution procedure; this patch does not delete append-only evidence to make it migrate.

CI for the original head is historical evidence only. The pushed correction requires its own
`verify` and `commerce` jobs; their result is recorded by GitHub on that head. Local database tests
and logical restore are not production recovery proof. No runtime Admin/SSR browser flow, real
Notisend delivery callback, payment, production migration, deployment, merge or sales admission
was exercised or authorized by this work.
