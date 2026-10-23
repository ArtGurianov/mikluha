import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface JournalEntry { readonly version: number; readonly file: string }
export interface LockedMigration extends JournalEntry { readonly checksum: string }
export interface Migration extends LockedMigration { readonly sql: string }

/** The same validator serves disk startup, the migrator, and every Git history snapshot. */
export function validateMigrations(read: (file: string) => string, names: readonly string[], requireLock = true): Migration[] {
  const journal: unknown = JSON.parse(read('journal.json'));
  if (!Array.isArray(journal) || journal.length === 0) throw new Error('MIGRATION_JOURNAL_INVALID');
  const files = journal.map((entry: JournalEntry, i) => {
    if (entry.version !== i + 1 || !new RegExp(`^${String(i + 1).padStart(4, '0')}_[a-z0-9_]+\\.sql$`).test(entry.file)) {
      throw new Error('MIGRATION_JOURNAL_INVALID');
    }
    const sql = read(entry.file);
    return { version: entry.version, file: entry.file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
  const sqlNames = names.filter(n => n.endsWith('.sql')).sort();
  if (JSON.stringify(sqlNames) !== JSON.stringify(files.map(f => f.file).sort())) throw new Error('MIGRATION_UNJOURNALED');
  if (requireLock || names.includes('migration.lock')) {
    const lock = JSON.parse(read('migration.lock'));
    if (lock.format !== 1 || !Array.isArray(lock.migrations) || lock.migrations.length !== files.length) throw new Error('MIGRATION_LOCK_INVALID');
    files.forEach((file, i) => {
      const e = lock.migrations[i];
      if (e?.version !== file.version || e.file !== file.file || e.checksum !== file.checksum) throw new Error(`MIGRATION_CHANGED: ${file.file}`);
    });
  }
  return files;
}

export function readMigrations(dir: string): Migration[] {
  return validateMigrations(file => readFileSync(join(dir, file), 'utf8'), readdirSync(dir));
}

export function assertAppendOnly(previous: readonly LockedMigration[], next: readonly LockedMigration[]): void {
  for (const e of previous) {
    const n = next[e.version - 1];
    if (!n || n.file !== e.file || n.checksum !== e.checksum) throw new Error(`MIGRATION_HISTORY_REWRITTEN: ${e.file}`);
  }
}
