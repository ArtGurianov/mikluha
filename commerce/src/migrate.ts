// Schema migrations: the files in migrations/journal.json, in order, each once, each in its own
// transaction, under an advisory lock so two deploys cannot interleave. An applied file whose content
// changed is refused: history is never rewritten, a fix is a new migration.

import type pg from 'pg';
import { readMigrations } from './migration-integrity.js';
export type { JournalEntry } from './migration-integrity.js';

const LOCK = 7_247_011;

export function readJournal(dir: string) {
  return readMigrations(dir).map(({ version, file, sql, checksum, compatibility }) => ({ entry: { version, file }, sql, checksum, compatibility }));
}

export function schemaHead(dir: string): number {
  return readJournal(dir).length;
}

/** Applies what is missing; returns the versions applied now. */
export async function migrate(client: pg.Client, dir: string): Promise<number[]> {
  const files = readJournal(dir);
  await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version int PRIMARY KEY, file text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ version: number; file: string; checksum: string }>('SELECT version, file, checksum FROM schema_migrations ORDER BY version');
    for (const r of rows) {
      if (r.version > files.length) throw new Error(`MIGRATION_UNKNOWN: the database has version ${r.version}, this build knows ${files.length}`);
    }
    rows.forEach((r, i) => {
      const expected = files[i];
      if (r.version !== i + 1 || !expected || r.file !== expected.entry.file || r.checksum !== expected.checksum) {
        throw new Error(`MIGRATION_CHANGED: database history at ${r.version}`);
      }
    });
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    // Existing attestations are immutable too; a rerun must never widen an old runtime approval.
    if (applied.has(12)) {
      const { rows: attestations } = await client.query('SELECT * FROM schema_migration_compatibility ORDER BY version');
      const expected = files.filter(f => applied.has(f.entry.version) && f.entry.version >= 12);
      if (attestations.length !== expected.length || expected.some((f, i) => {
        const a = attestations[i];
        return a.version !== f.entry.version || a.file !== f.entry.file || a.checksum !== f.checksum
          || JSON.stringify(a.runtime_commits) !== JSON.stringify(f.compatibility?.runtimeCommits) || a.evidence !== f.compatibility?.evidence;
      })) throw new Error('MIGRATION_COMPATIBILITY_CHANGED');
    }
    const done: number[] = [];
    for (const { entry, sql, checksum, compatibility } of files) {
      const have = applied.get(entry.version);
      if (have !== undefined) {
        if (have !== checksum) throw new Error(`MIGRATION_CHANGED: ${entry.file} differs from what was applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, file, checksum) VALUES ($1, $2, $3)',
          [entry.version, entry.file, checksum]);
        if (compatibility) await client.query(
          'INSERT INTO schema_migration_compatibility (version, file, checksum, runtime_commits, evidence) VALUES ($1, $2, $3, $4, $5)',
          [entry.version, entry.file, checksum, compatibility.runtimeCommits, compatibility.evidence]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      done.push(entry.version);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]);
  }
}
