# TOUR-57: clean PostgreSQL schema

The accepted Plane scope on 2026-10-30 is a new database from the complete,
append-only migration journal. Current source already contains migrations
0001–0017, including editorial identity/revisions, order contract snapshots,
schedule locking, Admin capabilities and purchase revisions. No new SQL or
migration number is needed for preparation. Agent A retains numbering authority.

Use the existing owner migrator in an immutable commerce image, pinned by Docker
image ID and checked against its immutable source identity. Run it against a
fresh PostgreSQL 16 instance on a newly created internal Docker network with
tmpfs storage, no published ports and no host mounts. No external database URL
is accepted. Remove only resources created by this invocation.

A separate dump assembled by concatenating SQL would bypass migrator history and
compatibility attestations. A new squash migration would rewrite history. Both
are rejected in favour of replaying the original checked journal.

The probe verifies a completely empty starting schema, every applied filename and
checksum, the compatibility attestations through schema readiness, and an
idempotent rerun preserving journal timestamps. It verifies disjoint NOLOGIN
capabilities, selected table/function privilege boundaries and absence of
customer, content and Admin account seeds. Only migration-owned bootstrap rows
are allowed: journal, compatibility registry, closed sales switch and DRAFT
processing instruction. Failures produce no completed manifest.

The command exports schema-only SQL for review and a JSON manifest containing
image IDs, source SHA, journal/lock hashes, migration checksums, row counts and
role checks. The export has no role passwords or globals and is not an
installation script: it excludes bootstrap data. Installation must execute the
same checked migrator. Existing real-PostgreSQL tests qualify identity, snapshot,
revision, schedule/seat locking and role restrictions. CI runs the new preparation
command against the exact PR HEAD image and retains its artifacts.

This source-only preparation has CUSTODY_IMPACT: NO. Installation, production
credentials, encrypted automatic off-host backup and the target logical restore
under TOUR-17 need their own evidence/authorization. Before real Admin/content/
legal entry, the accepted backup and isolated restore gate remains required.
Full PITR/external-device qualification is deferred until before real sales.
Sales remain CLOSED; the processing instruction remains DRAFT.
