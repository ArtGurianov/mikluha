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

for (const sabotage of ['sql', 'rehash', 'delete', 'rename', 'gap', 'unlisted', 'lock-delete', 'intermediate', 'policy'] as const) {
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
      if (sabotage === 'policy') {
        lock.migrations.at(-1).compatibility.runtimeCommits.push('a'.repeat(40));
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
      if (sabotage !== 'rehash' && sabotage !== 'intermediate' && sabotage !== 'policy') assert.throws(() => readMigrations(f.dir));
      assert.ok(bad);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('bootstrap locks the pre-lock SQL bytes and append-only migration succeeds', () => {
  const f = fixture();
  try {
    // The actual pre-lock baseline ends at 11; protocol metadata is introduced only afterward.
    const originalLock = JSON.parse(readFileSync(join(f.dir, 'migration.lock'), 'utf8'));
    originalLock.migrations = originalLock.migrations.slice(0, 11);
    const initialJournal = JSON.parse(readFileSync(join(f.dir, 'journal.json'), 'utf8'));
    for (const e of initialJournal.slice(11)) rmSync(join(f.dir, e.file));
    writeFileSync(join(f.dir, 'journal.json'), JSON.stringify(initialJournal.slice(0, 11)));
    rmSync(join(f.dir, 'migration.lock')); const prelock = f.commit();
    writeFileSync(join(f.dir, 'migration.lock'), JSON.stringify(originalLock));
    const boot = f.commit(); checkHistory(f.root, prelock, boot);
    const journal = JSON.parse(readFileSync(join(f.dir, 'journal.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(f.dir, 'migration.lock'), 'utf8'));
    const entry = { version: journal.length + 1, file: `${String(journal.length + 1).padStart(4, '0')}_forward.sql` };
    const sql = 'SELECT 1;\n';
    writeFileSync(join(f.dir, entry.file), sql);
    journal.push(entry); lock.migrations.push({ ...entry, checksum: createHash('sha256').update(sql).digest('hex'), compatibility: { runtimeCommits: [], evidence: 'incompatible fixture' } });
    writeFileSync(join(f.dir, 'journal.json'), JSON.stringify(journal));
    writeFileSync(join(f.dir, 'migration.lock'), JSON.stringify(lock));
    checkHistory(f.root, prelock, f.commit());
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function appendFixture(f: ReturnType<typeof fixture>) {
  const journal = JSON.parse(readFileSync(join(f.dir, 'journal.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(f.dir, 'migration.lock'), 'utf8'));
  const version = journal.length + 1, file = `${String(version).padStart(4, '0')}_forward.sql`;
  const sql = 'SELECT 42;\n';
  writeFileSync(join(f.dir, file), sql);
  journal.push({ version, file });
  lock.migrations.push({ version, file, checksum: createHash('sha256').update(sql).digest('hex'), compatibility: { runtimeCommits: [], evidence: 'DAG fixture' } });
  writeFileSync(join(f.dir, 'journal.json'), JSON.stringify(journal));
  writeFileSync(join(f.dir, 'migration.lock'), JSON.stringify(lock));
}

for (const kind of ['docs', 'cms']) {
  test(`PR behind a ${kind} base commit passes without rebase`, () => {
    const f = fixture();
    try {
      f.git('switch', '-qc', 'pr'); writeFileSync(join(f.root, 'feature.txt'), 'feature'); const head = f.commit();
      f.git('switch', '-qc', 'upstream', f.base);
      writeFileSync(join(f.root, kind === 'cms' ? 'catalog.yml' : 'README.md'), 'main changed');
      const base = f.commit();
      checkHistory(f.root, base, head);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('a migration added to base requires explicit synchronization', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'pr'); writeFileSync(join(f.root, 'feature.txt'), 'feature'); const head = f.commit();
    f.git('switch', '-qc', 'upstream', f.base); appendFixture(f); const base = f.commit();
    assert.throws(() => checkHistory(f.root, base, head), /MIGRATION_BASE_NOT_INCLUDED: synchronize migrations/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('merging main with a new migration validates each parent rather than a linearized order', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'pr'); writeFileSync(join(f.root, 'feature.txt'), 'feature'); f.commit();
    f.git('switch', '-qc', 'upstream', f.base); appendFixture(f); const base = f.commit();
    f.git('switch', 'pr'); f.git('merge', '--no-ff', '-m', 'merge upstream', base);
    checkHistory(f.root, base, f.git('rev-parse', 'HEAD'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a lock deleted and restored on a side branch is refused even after merge', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'side'); rmSync(join(f.dir, 'migration.lock')); f.commit();
    f.git('checkout', f.base, '--', 'commerce/migrations/migration.lock'); const side = f.commit();
    f.git('switch', '-qc', 'pr', f.base); writeFileSync(join(f.root, 'feature.txt'), 'feature'); f.commit();
    f.git('merge', '--no-ff', '-m', 'merge side', side);
    assert.throws(() => checkHistory(f.root, f.base, f.git('rev-parse', 'HEAD')), /MIGRATION_LOCK_REMOVED/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a merge cannot discard a migration from its second parent', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'side'); appendFixture(f); const side = f.commit();
    f.git('switch', '-qc', 'pr', f.base); writeFileSync(join(f.root, 'feature.txt'), 'feature'); f.commit();
    f.git('merge', '-s', 'ours', '--no-ff', '-m', 'drop side migration', side);
    assert.throws(() => checkHistory(f.root, f.base, f.git('rev-parse', 'HEAD')), /MIGRATION_HISTORY_REWRITTEN/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
