# ART-382 arrival review corrections

Independent review target: Mikluha PR #39, `f079315ca3013be16f49ef3e4c3d35de8ce01a1a`,
compared with its merge base on `main`. Refref contract checked at
`258e82ba5a5d9fa3fffb88489338d4822c3a3ade` (`docs/29` and `docs/openapi-vnext.yaml`).
The authorized scope is local corrections, tests and pushing the existing PR branch.

## Assessment

All four draft findings are confirmed:

- P1 retention: lazy expiry leaves the raw field resident indefinitely without later traffic.
- P1 capacity: the existing context single-flight still fans out to eight proofs, and there is
  no process-wide bound. Fresh proofs can also create one chained waiter per incoming request.
- P2 Buy budget: waiting on a shared attempt and its fresh-proof follow-up can exceed the budget.
- P2 permanent refusal: HTTP 401/403 and the documented HTTP 409
  `BROWSER_CONTEXT_IDLE_POLICY_REQUIRED` are incorrectly retried and eventually called TIMEOUT.

Further deadline inspection found that even a timeout race can accept an ACK after the cutoff:
when an earlier event-loop callback runs across the deadline, its microtasks may settle the claim
before the overdue timeout callback. Confirmation timestamps must therefore participate in the
frozen result. This has a dedicated regression.

## Chosen design

Keep the ephemeral model. One unref'ed timer expires actual raw fields at the next proof deadline,
independently of requests. An indexed min-heap owns pending proof for expiry; settlement and eviction
clear both the raw field and its heap/index entry immediately. The next deadline is O(1);
insertion, settlement and expiry are O(log n), with no full scan of pending proof. Staggered
deadlines rearm the timer. The diagnostic
`retainedRawProofs` reads actual fields without running lazy cleanup and exposes no credentials.

One FIFO per Arrivals instance admits at most 16 actual outbound claims and 64 waiting claims.
The production process has one instance. Queue time consumes the same 500 ms attempt deadline;
expired entries never reach transport. Overflow keeps proof pending and emits OVERLOADED;
queue expiry emits QUEUE_TIMEOUT. Both remain TIMEOUT and can retry on later traffic.
No IP throttle is added: shared NAT users retain the normal nonblocking redirect.
Same-context requests share one promise and one scheduled response hook. Fresh proofs captured
during an attempt receive one coalesced, tracked follow-up after it settles.

Buy uses one monotonic absolute deadline capped at 1500 ms, including shared attempts and queue
waiting. It races waiting against the remaining budget and treats confirmation observed after
the cutoff as TIMEOUT. A later Buy can use that confirmation; the earlier returned value stays
unchanged. Definitive configuration refusals erase raw proof, terminate retries for that proof,
and emit arrival_claim_configuration_failed with only HTTP status and a sanitized error code.
Temporary failures, rate limits and lost ACK remain uncertain.

Alternatives considered: periodic sweeping introduces a retention interval beyond TTL; per-proof
timers scale to every retained credential; ingress throttling alone does not bound outbound fanout;
a durable queue changes the accepted MVP custody model. None is needed for these corrections.

## Validation scope

Regression coverage includes timer-only retention, staggered expiry, bounded admission and
recovery from overload, a 100-request HTTP burst against hanging Refref, same-context coalescing,
queued expiry, shared-flight Buy deadlines, late ACK, busy-event-loop cutoff and configuration
refusals. The existing HTTP flow, lost-ACK replay, context rotation and RC.2 checkout tests remain.

Local validation uses Node 22.18.0 and a disposable PostgreSQL 16 container; pg_dump/psql execute
inside that same container. Production/browser qualification (Safari ITP and WebViews), owner
policy, verified destination, proxy/application log gate and ART-383 checkout wiring remain
separate gates. This change does not authorize merge, deployment or opening sales.

First correction results (`e020747`): commerce 159/159, site 75/75, root lint, commerce typecheck/build,
and git diff --check PASS. Exact-head GitHub Actions and the image build are checked after
committing; their final status is reported with the pushed SHA.

## Follow-up P2: expiry complexity

Review target `e02074762e61ac5b46fd6e5a12d2da7e56441eef`: the timer's Set traversal and
next-deadline scan repeat for every distinct expiry, approaching O(n²) at high pending counts.
This finding is confirmed. Replace only the retention index and timer traversal with the indexed
min-heap described above. Arbitrary removal avoids lazy heap tombstones retaining settled proof;
a FIFO alone would depend on capture-clock ordering. Claims, TTL, degradation, HTTP routes and
public Arrivals API retain their existing semantics.

Regression coverage adds 20,000 pending proofs with deadlines one millisecond apart, actual raw
field erasure without traffic, arbitrary settlement/equal deadlines, and deterministic O(n log n)
comparison bounds over 20,000 insertions/extractions. Earlier-deadline insertion is also covered.

Follow-up local validation: commerce 163/163, root lint, commerce typecheck and diff whitespace
checks PASS on Node 22.18.0 and disposable PostgreSQL 16. The same 20,000-proof integration
scenario was also run on an archived `e020747` source snapshot, independently confirming the
repeated-scan cost. Complexity assertions use comparison counts rather than timing thresholds.
