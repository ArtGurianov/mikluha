// Schema migrations: the files in migrations/journal.json, in order, each once, each in its own
// transaction, under an advisory lock so two deploys cannot interleave. An applied file whose content
// changed is refused: history is never rewritten, a fix is a new migration.

import type pg from 'pg';
import { readMigrations } from './migration-integrity.js';
export type { JournalEntry } from './migration-integrity.js';

const LOCK = 7_247_011;

export function readJournal(dir: string) {
  return readMigrations(dir).map(({ version, file, sql, checksum }) => ({ entry: { version, file }, sql, checksum }));
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
    rows.forEach((r, i) => {
      const expected = files[i];
      if (r.version !== i + 1 || !expected || r.file !== expected.entry.file || r.checksum !== expected.checksum) {
        throw new Error(`MIGRATION_CHANGED: database history at ${r.version}`);
      }
    });
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const v of applied.keys()) {
      if (v > files.length) throw new Error(`MIGRATION_UNKNOWN: the database has version ${v}, this build knows ${files.length}`);
    }
    const done: number[] = [];
    for (const { entry, sql, checksum } of files) {
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
