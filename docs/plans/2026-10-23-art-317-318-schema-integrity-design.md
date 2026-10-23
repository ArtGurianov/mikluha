# ART-317 → ART-318: migration integrity and schema readiness

ART-317 lands first: a committed SHA-256 lock for every journaled SQL file, strict file/journal/lock validation at startup and migration, and a full-history PR gate anchored to the event's base/head SHAs. Every commit must preserve each parent's SQL bytes and journal prefix, even when someone updates the hash or later reverts a change. The first lock is bootstrapped against the base's existing SQL, including 0001–0007. Migration application validates the entire existing database prefix before executing any pending SQL. Existing journal rows and timestamps remain untouched.

ART-318 adds an owner-managed, runtime-readable compatibility registry in a new forward migration. Each forward migration is classified in the immutable lock as incompatible (the default), or compatible with a finite list of exact, tested runtime source commits. The migrator records this classification in the same transaction as the SQL and journal entry. A runtime validates its bundled prefix against the database and accepts each ahead version only with matching registry identity/checksum and explicit approval for its immutable image source SHA. Gaps, altered history, unknown versions, missing metadata, an unapproved SHA and a database behind the image all fail closed. Admin API and commerce use the same check. Legal-release admission remains independent and still requires an exact source match.

A bundled future allowlist would require rebuilding the old image; using `>=` would accept arbitrary future changes. The owner-authored registry supports unchanged protocol-aware images, with the database owner remaining the schema authority. This cannot make pre-protocol images forward-compatible: the first upgrade is strict. No existing migration is declared compatible retroactively. Qualification uses an isolated PostgreSQL and an unchanged compiled runtime against an appended additive fixture; negative and rollback cases exercise the same path. Such fixtures establish the protocol and tested operations, not compatibility of an untested real future migration or production release. Future approvals require evidence for the actual old image digest/source SHA and the actual new migration checksum.

No production migration, host mutation, deployment, merge, or sales activation is part of this PR. CUSTODY_IMPACT: NO — code and CI only.

## Review corrections: operation admission and complete attestations

HTTP routing readiness is insufficient for workers or direct requests. A separate schema-only admission checks every commerce/Admin application request, each worker step and each after-response arrival task, without caching READY. A refusal never invokes the callback. Health and identity remain inspectable. Legal-release admission retains its existing independent behavior; a legal mismatch alone does not block reconciliation or delivery of existing obligations. Known attestations from version 0012 are checked against the bundled lock, including identity, approved runtime list and evidence, at both exact head and ahead schemas.

On SIGTERM/SIGINT, both processes stop timers and new admission, wait for admitted HTTP/worker work, drain tracked arrival work, then close pools and exit successfully. An operation already admitted may complete: this is necessary to finish provider readback and outbox state after external I/O. An admission check cannot serialize application I/O with owner DDL. For incompatible SQL, the owner must first remove traffic, stop and drain every old commerce/Admin instance, verify successful exit and no old sessions or external work, and only then apply migrations. Timeout/SIGKILL or an ambiguous external send is a failed drain that requires reconciliation before migration. Pre-protocol images need the same coordinated procedure. This PR does not execute any rollout step.


## Keep from original plan

Keep immutable SQL/classifications, exact-SHA approvals, no READY cache, independent legal admission and owner-controlled incompatible-SQL stop/drain. No new migration or production action is needed.

## Adopt from alternative plan

Critical fixes: compare Git DAG edges and base/head migration prefixes so unrelated main changes do not break stale PRs; split merge-tree integration CI from verified exact-HEAD image qualification so image identity describes its source. Material improvements: use a single schema query for readyz and pre-register Arrival obligations before response close, rechecking live schema when a shutdown ticket executes. Minor enhancements: import ordering and an explicit schema-12 fixture update instruction.

## Reject from alternative plan

Do not add a short-lived READY cache without load measurements: it adds a stale-admission window. Do not bypass schema checks for all draining work: only tasks registered before stopping get a ticket, and they still check schema. Do not change branch access rules in this PR; document direct-push residual risk and the separate path-scoped follow-up.

## Conflicts / decisions needed

The proposals are compatible with the existing owner/deployment boundaries; no user decision is required. A new exact-HEAD CI job adds build cost but separates integration and identity evidence. Registration creates a drain obligation that may wait for a response to close; a forced stop remains a failed graceful drain.

## Risk delta

DAG checks retain edit-then-revert and per-branch lock protection. Registered Arrival claims can execute after SIGTERM only on a compatible schema. Stop/drain still does not serialize DDL with application I/O, qualify a merged release candidate, or make memory-only arrival proof durable after an ambiguous send/crash.

## Revised merged plan

Validate every relevant parent/child snapshot and latest base prefix; test stale docs/CMS branches and merges. Keep merge-tree tests and build a separately checked exact-HEAD image, asserting expected source identity inside the probe. Reuse the schema result on readyz. Track response-close obligations immediately and prohibit new registrations at shutdown while draining existing tickets and coalesced fresh proofs. Run real-signal negative tests, the full PostgreSQL suite, the exact-image probe and final-head CI.


Integration with main ART-327 preserves the business-sabotage job. Its SQL mutants are rehashed only
inside disposable scratch copies, with SQL and lock restored together, so failures still require
the selected business assertion rather than an integrity/setup error. Committed history and lock
checks remain strict. The actual merge also exercises the two-parent DAG validation path.


## Final shutdown review

A request admitted before SIGTERM may register its Arrival obligation after shutdown begins but
before the handler returns. AsyncLocalStorage carries a private live request lease; its active flag
is revoked in finally so detached descendants cannot register after return. Workers and new HTTP
requests receive no such lease. Both AfterResponse and SchemaAdmission require that lease to accept
late registration; every ticket still checks live schema before sending. Admission drain repeatedly
awaits its pending set so tickets added by an in-flight request cannot outlive pool shutdown. Tests
cover actual HTTP wiring, real SIGTERM, incompatible schema, unrelated async contexts and revoked
detached descendants. Snapshot caching for migration history remains deferred without a performance
need; it has no effect on the correctness boundary.
