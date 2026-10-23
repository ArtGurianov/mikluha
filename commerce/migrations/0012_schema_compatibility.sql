-- ART-318: owner-written compatibility attestations, atomic with migration application.
-- Runtime roles can read these records but cannot authorize their own compatibility.
CREATE TABLE schema_migration_compatibility (
  version int PRIMARY KEY REFERENCES schema_migrations(version),
  file text NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  runtime_commits text[] NOT NULL,
  evidence text NOT NULL CHECK (length(evidence) > 0),
  CHECK (version >= 12)
);
REVOKE ALL ON schema_migration_compatibility FROM PUBLIC;
GRANT SELECT ON schema_migration_compatibility TO commerce_app, admin_app;
