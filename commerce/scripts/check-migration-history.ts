import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAppendOnly, readMigrations, validateMigrations } from '../src/migration-integrity.js';

export function checkHistory(repo: string, base: string, head: string): void {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  // Resolve refs before passing them to revision expressions. CI supplies event SHAs, never main.
  base = git('rev-parse', '--verify', `${base}^{commit}`);
  head = git('rev-parse', '--verify', `${head}^{commit}`);
  git('merge-base', '--is-ancestor', base, head);
  const prefix = 'commerce/migrations/';
  // git show must preserve bytes (including the lack of a final newline).
  function exactSnapshot(commit: string, requireLock: boolean) {
    const names = git('ls-tree', '--name-only', `${commit}:${prefix.slice(0, -1)}`).split('\n');
    return validateMigrations(file => execFileSync('git', ['-C', repo, 'show', `${commit}:${prefix}${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), names, requireLock);
  }
  let previous = exactSnapshot(base, false);
  let locked = git('ls-tree', '--name-only', base, '--', `${prefix}migration.lock`) !== '';
  for (const commit of git('rev-list', '--reverse', '--topo-order', `${base}..${head}`).split('\n').filter(Boolean)) {
    try {
      const next = exactSnapshot(commit, locked);
      assertAppendOnly(previous, next);
      previous = next;
      locked ||= git('ls-tree', '--name-only', commit, '--', `${prefix}migration.lock`) !== '';
    } catch (error) { throw new Error(`${commit}: ${String(error)}`); }
  }
  exactSnapshot(head, true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error('usage: check-migration-history.ts BASE_SHA HEAD_SHA');
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  readMigrations(resolve(repo, 'commerce/migrations'));
  checkHistory(repo, base, head);
  console.log('MIGRATION_HISTORY=PASS');
}
