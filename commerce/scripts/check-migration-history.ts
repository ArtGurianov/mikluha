import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAppendOnly, readMigrations, validateMigrations } from '../src/migration-integrity.js';

export function checkHistory(repo: string, base: string, head: string): void {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  // Resolve refs before passing them to revision expressions. CI supplies event SHAs, never main.
  base = git('rev-parse', '--verify', `${base}^{commit}`);
  head = git('rev-parse', '--verify', `${head}^{commit}`);
  const common = git('merge-base', '--all', base, head).split('\n');
  const prefix = 'commerce/migrations/';
  const snapshots = new Map<string, { locked: boolean; migrations: ReturnType<typeof validateMigrations> }>();
  // Preserve SQL bytes. Validate each snapshot once; lock inheritance is checked per DAG edge.
  function snapshot(commit: string) {
    let value = snapshots.get(commit);
    if (!value) {
      const names = git('ls-tree', '--name-only', `${commit}:${prefix.slice(0, -1)}`).split('\n');
      value = { locked: names.includes('migration.lock'), migrations: validateMigrations(file =>
        execFileSync('git', ['-C', repo, 'show', `${commit}:${prefix}${file}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), names, false) };
      snapshots.set(commit, value);
    }
    return value;
  }
  for (const ancestor of common) snapshot(ancestor);
  // Include both divergent branches. A topological listing is not a linear migration history:
  // every child must preserve EVERY parent, including the second parent of a merge.
  const commits = git('rev-list', '--reverse', '--topo-order', base, head, '--not', ...common).split('\n').filter(Boolean);
  for (const commit of commits) {
    try {
      const next = snapshot(commit);
      const parents = git('show', '-s', '--format=%P', commit).split(' ').filter(Boolean);
      for (const parent of parents) {
        const previous = snapshot(parent);
        if (previous.locked && !next.locked) throw new Error('MIGRATION_LOCK_REMOVED');
        assertAppendOnly(previous.migrations, next.migrations);
      }
    } catch (error) { throw new Error(`${commit}: ${String(error)}`); }
  }
  const proposed = snapshot(head);
  if (!proposed.locked) throw new Error('MIGRATION_LOCK_REQUIRED');
  try { assertAppendOnly(snapshot(base).migrations, proposed.migrations); }
  catch (error) { throw new Error(`MIGRATION_BASE_NOT_INCLUDED: synchronize migrations with base ${base}: ${String(error)}`); }

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error('usage: check-migration-history.ts BASE_SHA HEAD_SHA');
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  readMigrations(resolve(repo, 'commerce/migrations'));
  checkHistory(repo, base, head);
  console.log('MIGRATION_HISTORY=PASS');
}
