# Review corrections, 19 October 2026

Implement the reviewed ART-357/373/375/374/199/275/339 corrections in the existing PRs.
C2 is the single browser-context authority; C1 links arrivals through it. LAB lifecycle and
seat admission precede durable checkout intents. Refref deadlines, stable order identity,
and typed definitive refusals must survive replay. Unknown payments retain their fence.
Schema fingerprints qualify the final migration chain; old backup hashes remain explicit.
Mikluha conformance pins an exact candidate and does not imply mutable-HEAD qualification.
Regression tests cover the reviewed boundaries. No production migration, sales activation,
merge, or live payment is part of this change. An unspecified privacy duration requires an
explicit policy; it must not be invented as a migration default.

Follow-up CI review: pg-pool end removes clients before socket-end callbacks complete; FORCE drop
can terminate those still-closing clients and emit fatal asynchronous activity after a test ends.
Track real pooled-client end events, await them, and drop without FORCE. A delayed-close regression
reproduces the original FATAL before the fix and passes afterwards; no database errors are swallowed.
SQL proves snapshot shape and hash format, not JCS equality. Test the independent verifier on a
direct-owner insert with a wrong well-formed digest, and keep DB-backed writer qualification explicit.


Round-four: bound the entire test database teardown to 10 seconds by default, including pool.end(),
not only socket close events. Timeout diagnostics name the disposable DB and outstanding pool clients.
A test may release a leaked client and await the cached cleanup again; no FORCE drop or swallowed error.
A regression uses a 50ms bound and a rescue release against the old helper to avoid hanging the runner.
