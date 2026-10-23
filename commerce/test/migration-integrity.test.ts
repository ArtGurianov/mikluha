import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkHistory } from '../scripts/check-migration-history.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { readMigrations } from '../src/migration-integrity.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'migration-history-'));
  const dir = join(root, 'commerce/migrations');
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit();
  return { root, dir, git, commit, base };
}

for (const sabotage of ['sql', 'rehash', 'delete', 'rename', 'gap', 'unlisted', 'lock-delete', 'intermediate'] as const) {
  test(`immutable history refuses ${sabotage}`, () => {
    const f = fixture();
    try {
      const path = join(f.dir, '0001_orders.sql');
      const original = readFileSync(path, 'utf8');
      const lockPath = join(f.dir, 'migration.lock');
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (['sql', 'rehash', 'intermediate'].includes(sabotage)) writeFileSync(path, original + '-- sabotage\n');
      if (sabotage === 'rehash') {
        // Mechanically recompute every hash, simulating an attacker updating SQL and the lock together.
        lock.migrations[0].checksum = createHash('sha256').update(readFileSync(path)).digest('hex');
        writeFileSync(lockPath, JSON.stringify(lock));
      }
      if (sabotage === 'delete') rmSync(path);
      if (sabotage === 'rename') { writeFileSync(join(f.dir, '0001_renamed.sql'), original); rmSync(path); }
      if (sabotage === 'gap') writeFileSync(join(f.dir, 'journal.json'), JSON.stringify([{ version: 2, file: '0001_orders.sql' }]));
      if (sabotage === 'unlisted') writeFileSync(join(f.dir, '9999_unlisted.sql'), 'SELECT 1;');
      if (sabotage === 'lock-delete') rmSync(lockPath);
      const bad = f.commit();
      if (sabotage === 'intermediate') { writeFileSync(path, original); f.commit(); }
      assert.throws(() => checkHistory(f.root, f.base, f.git('rev-parse', 'HEAD')));
      if (sabotage !== 'rehash' && sabotage !== 'intermediate') assert.throws(() => readMigrations(f.dir));
      assert.ok(bad);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('bootstrap locks the pre-lock SQL bytes and append-only migration succeeds', () => {
  const f = fixture();
  try {
    rmSync(join(f.dir, 'migration.lock')); const prelock = f.commit();
    f.git('checkout', f.base, '--', 'commerce/migrations/migration.lock');
    const boot = f.commit(); checkHistory(f.root, prelock, boot);
    const journal = JSON.parse(readFileSync(join(f.dir, 'journal.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(f.dir, 'migration.lock'), 'utf8'));
    const entry = { version: journal.length + 1, file: `${String(journal.length + 1).padStart(4, '0')}_forward.sql` };
    const sql = 'SELECT 1;\n';
    writeFileSync(join(f.dir, entry.file), sql);
    journal.push(entry); lock.migrations.push({ ...entry, checksum: createHash('sha256').update(sql).digest('hex') });
    writeFileSync(join(f.dir, 'journal.json'), JSON.stringify(journal));
    writeFileSync(join(f.dir, 'migration.lock'), JSON.stringify(lock));
    checkHistory(f.root, prelock, f.commit());
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
