// A merge-tree must never be labelled with a different source commit for qualification.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertImageSource(repo, expected) {
  if (!/^[a-f0-9]{40}$/.test(expected ?? '')) throw new Error('IMAGE_SOURCE_SHA_REQUIRED');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const actual = git('rev-parse', 'HEAD');
  if (actual !== expected) throw new Error(`IMAGE_SOURCE_MISMATCH: expected ${expected}, checkout ${actual}`);
  if (git('status', '--porcelain', '--untracked-files=no') !== '') throw new Error('IMAGE_SOURCE_DIRTY');
  return { sourceCommit: actual, sourceTree: git('rev-parse', 'HEAD^{tree}') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  console.log(JSON.stringify(assertImageSource(repo, process.argv[2])));
}
