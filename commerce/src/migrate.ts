// Schema migrations: the files in migrations/journal.json, in order, each once, each in its own
// transaction, under an advisory lock so two deploys cannot interleave. An applied file whose content
// changed is refused: history is never rewritten, a fix is a new migration.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type pg from 'pg';

export interface JournalEntry { readonly version: number; readonly file: string }

const LOCK = 7_247_011;

export function readJournal(dir: string): { entry: JournalEntry; sql: string; checksum: string }[] {
  const journal = JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8')) as JournalEntry[];
  journal.forEach((e, i) => {
    if (e.version !== i + 1) throw new Error(`MIGRATION_JOURNAL_GAP: entry ${i} has version ${e.version}`);
  });
  return journal.map((entry) => {
    const sql = readFileSync(join(dir, entry.file), 'utf8');
    return { entry, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
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
    const { rows } = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations');
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
