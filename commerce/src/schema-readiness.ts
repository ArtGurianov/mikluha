import type pg from 'pg';
import type { LockedMigration } from './migration-integrity.js';

export interface SchemaBuild {
  readonly schemaHead: number;
  readonly migrations: readonly LockedMigration[];
  readonly sourceCommit: string | null;
}
export interface SchemaReadiness { status: 'READY' | 'NOT_READY'; reason?: string; schema?: number }

/** One snapshot of owner-authored history; max(version) alone proves neither integrity nor compatibility. */
export async function schemaReadiness(pool: pg.Pool, build: SchemaBuild): Promise<SchemaReadiness> {
  try {
    const { rows } = await pool.query<{
      version: number; file: string; checksum: string;
      approved_file: string | null; approved_checksum: string | null; runtime_commits: string[] | null; evidence: string | null;
    }>(`SELECT m.version, m.file, m.checksum, c.file AS approved_file, c.checksum AS approved_checksum, c.runtime_commits, c.evidence
        FROM schema_migrations m LEFT JOIN schema_migration_compatibility c USING (version) ORDER BY m.version`);
    const schema = rows.at(-1)?.version ?? 0;
    const refuse = (reason: string): SchemaReadiness => ({ status: 'NOT_READY', reason, schema });
    if (schema < build.schemaHead) return refuse('SCHEMA_NOT_AT_HEAD');
    if (build.migrations.length !== build.schemaHead || build.schemaHead < 12) return refuse('SCHEMA_BUILD_INVALID');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.version !== i + 1) return refuse('SCHEMA_HISTORY_MISMATCH');
      const known = build.migrations[i];
      if (row.version >= 12 && (row.approved_file !== row.file || row.approved_checksum !== row.checksum)) {
        return refuse(known ? 'SCHEMA_ATTESTATION_MISMATCH' : 'SCHEMA_AHEAD_UNKNOWN');
      }
      if (known) {
        if (row.version >= 12 && (!known.compatibility
          || JSON.stringify(row.runtime_commits) !== JSON.stringify(known.compatibility.runtimeCommits)
          || row.evidence !== known.compatibility.evidence)) return refuse('SCHEMA_ATTESTATION_MISMATCH');
        if (row.file !== known.file || row.checksum !== known.checksum) return refuse('SCHEMA_HISTORY_MISMATCH');
      } else {
        if (row.approved_file !== row.file || row.approved_checksum !== row.checksum) return refuse('SCHEMA_AHEAD_UNKNOWN');
        if (!build.sourceCommit || !/^[a-f0-9]{40}$/.test(build.sourceCommit)
          || !Array.isArray(row.runtime_commits) || !row.runtime_commits.includes(build.sourceCommit)) return refuse('SCHEMA_AHEAD_INCOMPATIBLE');
      }
    }
    return { status: 'READY', schema };
  } catch { return { status: 'NOT_READY', reason: 'DATABASE_UNAVAILABLE' }; }
}
