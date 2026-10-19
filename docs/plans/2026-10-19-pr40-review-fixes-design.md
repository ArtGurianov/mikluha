# PR #40 review corrections (ART-358)

Review baseline: `ff53144a41a55d19461242563e67a22f7b3cff06`, compared with `origin/main`.
Both P1 findings are confirmed by tracing the SQL commands and their public consumers.

Use a forward migration, preserving checksums of migrations 0008 and 0009. A classified execution
change has one identity `(departure_id, from_version, draft_revision)`. Under the existing departure
row lock, an exact MATERIAL retry returns the original change and affected-order count without new
events or audit rows, even if order eligibility has since changed. A different notice or
classification for that identity is a typed conflict. This avoids advancing an unpublished draft
merely for retry handling. A newly saved draft has a new revision; move/cancel resolution is separate.

Keep publication and listing distinct: a departure may reference a published, unlisted organizer,
but public_departure hides the entire departure until every organizer is published and listed.
Reports tied to that departure use the same projection so visibility propagates through the graph.
Hidden drafts do not affect public visibility.

The P2 observations are integration obligations. Document the missing delivery-report consumer and
OWNER-session authorization/audit binding as ART-363/365 acceptance requirements. ACCEPTED means
acceptance only; classified_by is caller-supplied metadata, not proof of OWNER authority.

Regressions cover sequential and overlapping MATERIAL retries, rejected reclassification, hidden
organizers before departure publication and after organizer republication, transitive report
visibility and unchanged order snapshots. Run the commerce suite against disposable PostgreSQL 16,
including logical dump/restore and typecheck, then check CI for the pushed head. No merge,
production migration, deployment or sales opening.
