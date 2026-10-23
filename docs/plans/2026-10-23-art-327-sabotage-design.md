# ART-327: business-invariant fault injection

Use the current merchant implementation at `origin/main` (`22a1d5f`) as the
subject, with the real migrations, runtime/operator roles and HTTP Refref client.
Synthetic fixtures and a loopback Refref server are the only external inputs.
No provider, mail or EIS account is contacted.

Three approaches were considered: a standalone model (cannot establish runtime
guards), production fault switches (unnecessary attack surface), and mechanical
mutations in disposable source copies. Use the third approach. Each selected
regression must pass unchanged, fail with its named business assertion when its
guard is removed, and pass again after restoration. Compilation errors, database
setup errors and timeouts cannot count as a killed mutation. Refuse mutation
anchor drift. Never edit the working checkout or deploy mutated code.

The regression suite exercises stop-sales in both lock orders, last-seat
concurrency, identical attempt replay, paid/fulfilment compare-and-set, legal and
document freshness, crossed browser/resolution identities, outgoing PII
projection, immutable contract data, ambiguous provider initiation and lost
fulfilment ACK, Notisend ambiguity/restart, and manual EIS stale/replayed filing.
Concurrency barriers inspect PostgreSQL lock waiters or stop a loopback HTTP
response; sleeps alone are not evidence of reaching a boundary.

The mutation runner gets an explicit loopback `TEST_DATABASE_URL` for a disposable
superuser server. Every subprocess migrates and drops its own database. Run the
suite in ordinary commerce tests and mutation sensitivity as a separate CI step.

Coverage boundaries remain visible: this tree has no merchant refund adapter or
provider callback/receipt issuer. Duplicate/lost-ACK refunds and actual provider
payment/receipt deduplication cannot be qualified by a fake Refref. Those remain
ART-263/268/275/285/412 and ART-327 acceptance gaps. ART-362's future checkout from
immutable contracts is also independent. This PR neither installs nor admits a
financial flow, and ART-327 must not be marked Done on this evidence alone.

## PR #47 review follow-up

The review confirmed a pre-existing runtime gap: HTTP 200 alone admitted local
fulfilment. Validate the ACK body at the fulfilment decision: an object with
`checkoutAttemptId === attemptId` and `status === 'DELIVERED'`. Keep the HTTP
client's body `unknown` to avoid treating a TypeScript type as runtime validation.
The fake must return the real attempt UUID and support corrupt ACK responses.
BI22–BI24 cover foreign/malformed IDs, non-delivered statuses and malformed
bodies corrupted in transit, followed by replay of the saved correct ACK. Separate mutations remove the
identity, status and body guards. BI05 retains transport/lost-ACK coverage.

The rejected ACK leaves `PAID` and queues no confirmation. Refref stores the
first response for an idempotency key/body (migration 000011, 24-hour retention),
so a persisted bad response cannot be repaired by repeating the same request.
The fake must preserve that response even when its current response configuration
changes. BI25 proves this stays PAID across restart/reconciliation and raises
paidNotFulfilled with no email. A separate one-shot transport override corrupts
only an outgoing response; BI26 proves the next replay of the saved correct ACK
recovers without changing fault configuration. Mutations of fake persistence
and one-shot consumption make both model assumptions test-sensitive. No automatic
key rotation or post-expiry recovery is claimed. Log rejected answered ACKs with
only orderRef and HTTP status, never the response body.

The EIS obligation
belongs to the proven payment, independently of ACK, and must stay pending.
BI04 records all concurrent pay outcomes and counts same-attempt session calls.
Document disposable-server cleanup on timeout: forced termination cannot promise
that the child's database teardown hook ran. No production fault hooks or schema
changes are needed.
