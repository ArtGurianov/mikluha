import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { assertImageSource } from '../scripts/check-image-source.mjs';

test('qualification refuses a differing merge checkout, accepts exact HEAD, refuses tracked dirt', () => {
  const repo = mkdtempSync(join(tmpdir(), 'image-source-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'catalog.yml'), 'original content'); const root = commit();
    git('switch', '-qc', 'pr'); writeFileSync(join(repo, 'runtime.txt'), 'PR runtime'); const head = commit();
    git('switch', '-qc', 'upstream', root); writeFileSync(join(repo, 'catalog.yml'), 'CMS update'); const base = commit();
    git('switch', 'pr'); git('merge', '--no-ff', '-m', 'test merge', base);
    assert.notEqual(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', `${head}^{tree}`));
    assert.throws(() => assertImageSource(repo, head), /IMAGE_SOURCE_MISMATCH/);
    git('checkout', '--detach', head);
    assert.equal(assertImageSource(repo, head).sourceCommit, head);
    assert.equal(readFileSync(join(repo, 'catalog.yml'), 'utf8'), 'original content');
    writeFileSync(join(repo, 'runtime.txt'), 'modified');
    assert.throws(() => assertImageSource(repo, head), /IMAGE_SOURCE_DIRTY/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('workflow separates merge-tree tests from exact-HEAD qualification and passes expected SHA to probe', () => {
  const workflow = yaml.load(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as any;
  const integration = workflow.jobs.commerce;
  assert.equal(integration.steps[0].with.ref, undefined);
  const proof = workflow.jobs['commerce-image'];
  assert.equal(proof.steps[0].with.ref, '${{ github.event.pull_request.head.sha }}');
  assert.equal(proof.env.EXPECTED_HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
  assert.ok(proof.steps.some((step: any) => step.run?.includes('check-image-source.mjs "$EXPECTED_HEAD_SHA"')));
  assert.ok(proof.steps.some((step: any) => step.run?.includes('qualify-schema-image.ts mikluha-commerce:head-ci "$EXPECTED_HEAD_SHA"')));
});
