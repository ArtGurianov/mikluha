# Prepare a clean PostgreSQL schema (TOUR-57)

Run from a clean checkout of the reviewed commit, with Docker available and the
commerce package installed. The command accepts an image, its expected full
source SHA and a **new** output directory whose parent exists. It creates its own
disposable PostgreSQL instance; it has no option to connect to the VPS or an
existing database.

From the repository root:

```sh
SOURCE_COMMIT=$(git rev-parse HEAD)
node commerce/scripts/check-image-source.mjs "$SOURCE_COMMIT"
docker pull postgres:16-alpine
docker build -f commerce/Dockerfile --build-arg SOURCE_COMMIT="$SOURCE_COMMIT" -t mikluha-commerce:tour57 .
node commerce/scripts/prepare-clean-schema.mjs mikluha-commerce:tour57 "$SOURCE_COMMIT" /tmp/mikluha-clean-schema-receipt
```

`manifest.json` records the actual image IDs (including PostgreSQL), immutable
commerce source SHA, journal and lock SHA-256, each migration identity, role
checks, table row counts, default gates and the SHA-256 of `schema.sql`.
The command refuses an existing output directory. An incorrect source identity,
modified/missing SQL, nonempty schema, journal/attestation mismatch, unsafe role
boundary or unexpected seed fails preparation. Containers and the internal
network are cleaned on success and handled failures. After a process kill or
Docker outage, inspect resources with the `tour57-` prefix and this run's suffix;
do not remove unrelated containers or networks.

`schema.sql` is a schema-only **review artifact**. It contains object ownership
and grants to NOLOGIN capability roles, but no globals, credentials or bootstrap
rows. Do not install it with `psql`. For an owner-authorized installation into a
new database, use `dist/bin/migrate.js` from the qualified image and its exact
bundled `migrations/` as described in the Commerce README. Do not concatenate,
squash, truncate or renumber the original journal, or edit its locked checksums.
The migrator is the only bootstrap authority.

The preparation command checks empty tables and capability ACLs. The Commerce
integration suite additionally exercises actual isolated login sessions,
immutable identities/order snapshots, stale and concurrent revision publishing,
schedule locks, capacity races and a synthetic logical restore. The latter is
test evidence, not the new production database's recovery receipt.

Before real Admin/content/legal entry, TOUR-17 must provide automatic encrypted
off-host backup and an isolated logical restore of the installed target. Full
PITR/external-device qualification remains required before real sales. Fresh
deployment resources need explicit owner authorization and their own custody
record. This command does not install services, change host state, create real
Admin accounts, approve legal documents or open sales. `processing_instruction`
stays DRAFT; the global sales switch stays CLOSED. No legacy database restoration,
row import, static parity or old-runtime compatibility is required by TOUR-57's
accepted clean-slate scope.
