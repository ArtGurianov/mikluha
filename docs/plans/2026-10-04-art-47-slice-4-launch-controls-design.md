# ART-47 slice 4 launch-controls design

This is the reviewed-code gate before production operations. It does not deploy, mutate a production
database, configure Refref, open sales, or make a real payment. Those actions remain owner-run after
the pull request and the host-recovery work are reviewed.

## Immutable release and legal admission

Both production images are built from one 40-hex source commit. The static site publishes a
build-generated `/release.json` containing that commit and the exact `oferta` and `soglasie-pd`
references and hashes. Nginx serves it with `no-store`.

Commerce reads its source commit from a read-only JSON file created in a dedicated Docker build
stage. Production has no environment fallback and cannot override the file at runtime. Production
also refuses non-HTTPS public or Refref addresses.

Before commerce listens, on every readiness check, before every new reservation, and again before a
reserved order starts payment, it fetches the live site's release descriptor and compares all five
values with its own image and catalog. A missing, unreadable, stale, or different descriptor fails
closed. This deliberately couples new sales to the public legal release: publishing a new site commit
immediately stops an older commerce image from recording the previous legal versions.

## Ambiguous checkout-attempt recovery

The fixed idempotency key remains the first protection. If checkout-attempt creation has an ambiguous
answer, commerce reads Refref's merchant-order projection. Exactly one attempt matching both the
frozen snapshot hash and referral-resolution id is adopted locally. No attempts means the same create
may be retried later; any non-matching or multiple projection is held for an operator. A recovered
attempt is the only attempt used for payment-session and subsequent read-back calls.

## Monitoring and operations

A runtime CLI emits only aggregate, non-personal signals: PAID orders not yet fulfilled and HELD
orders, with counts and oldest ages. Host integration later combines these with public readiness,
logical backup age, WAL shipping and base-backup age.

The launch runbook is an evidence checklist. It keeps sales closed through owner-run migration, role
creation, Coolify/TLS, separate `mikluha-recovery` backup installation, access-log token-redaction
proof, Refref Business configuration, signed PD-processing instruction, and real contract content.
Only after those gates pass may the owner open sales and make the first real payment, followed by the
manual ЕИС filing evidence required to close ART-293.
