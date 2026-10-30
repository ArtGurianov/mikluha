# TOUR-57 clean-schema preparation — 2026-10-30

Local preparation PASS. This is source-only qualification, not a VPS
installation or a production recovery receipt. CUSTODY_IMPACT: NO.

The accepted Plane scope is a clean target database from the original complete
journal, preserving all applied history/checksums. Sales remain CLOSED and the
processing instruction DRAFT. Production installation and TOUR-17 backup/restore
acceptance remain separate.

## Reproducible receipt

[clean-schema-manifest.json](clean-schema-manifest.json) records:

- Commerce source: `089656e0201b7a2aff9d2c9747feabfcf835dfd2`.
- Commerce image: `sha256:0183aab7bcc0eba4bafdc1b7c955da8a9809267bbd7be415b98d7a45df51eec2`.
- PostgreSQL 16.15, image ID recorded in the manifest.
- Exact migrations 0001–0017, journal/lock hashes and per-file checksums.
- 35 tables; only the four expected bootstrap tables contain rows.
- Five disjoint NOLOGIN capability roles with no privileged flags or membership
  edges; selected table/column and function capability boundaries pass.
- An unchanged second migrator run, including original journal timestamps.
- Schema readiness READY, sales CLOSED and processing instruction DRAFT.
- SHA-256 of the schema-only review export and both preparation scripts.

Command from the repository root, after building the exact-source image:

```sh
node commerce/scripts/prepare-clean-schema.mjs mikluha-commerce:tour57 \
  089656e0201b7a2aff9d2c9747feabfcf835dfd2 /tmp/tour57-clean-schema-qualified
```

The generated SQL's SHA-256 was independently checked against the manifest.
SQL is generated for review, not committed as a competing bootstrap definition.
CI uploads the manifest and SQL from the final PR HEAD image. This committed
receipt identifies the implementation commit above; later evidence-only commits
are not relabelled as that image. Future journal changes require fresh evidence.

## Validation

- Commerce TypeScript check: PASS.
- Migration DAG/history check against `origin/main`: PASS. No migration SQL,
  journal entry, lock entry or compatibility approval was changed.
- Full Commerce suite: 389 passed, 0 failed/skipped/cancelled, using disposable
  PostgreSQL and synthetic fixtures. Includes actual role logins, identity,
  order snapshot, revision/concurrent publication, schedule locking, capacity
  and logical dump/restore tests. The test container used source `5b3a4573a9469c6e518193f3d6c09a65380ca403`;
  runtime, test and migration bytes are unchanged at the qualified commit.
- Existing exact-image forward-schema probe: PASS, bundled schema 17 with an
  additive test-only schema 18, including native purchase/reservation, contract,
  state, maintenance, refusal and rollback cases. This is protocol evidence,
  not approval of a real future migration.
- Incorrect expected source SHA: refused with `IMAGE_SOURCE_MISMATCH`; no
  artifacts produced. The negative case is also in CI.
- Existing output directory: refused with `EEXIST`; the earlier receipt was
  retained.
- All local preparation/test containers and internal networks removed on exit.

All database workloads used new local Docker instances with tmpfs storage.
Preparation used an internal network, no published ports and no host mounts.
The full test runner shared its disposable PostgreSQL container's network, used
loopback credentials and had no provider/production access. No VPS, S3,
production keys, shared services or live financial operations were changed.

See the [runbook](../../../commerce/runbooks/clean-schema.md) for the authoritative
installation boundary and the outstanding target recovery gate.
