import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ExpiryQueue } from '../src/expiry-queue.js';

test('indexed expiry queue preserves order after arbitrary settlement, duplicates and equal deadlines', () => {
  const queue = new ExpiryQueue<{ expiresAt: number }>();
  const entries = Array.from({ length: 2048 }, (_, i) => ({ expiresAt: ((i * 811) % 2048) >> 1 }));
  for (const entry of entries) { queue.add(entry); queue.add(entry); }
  assert.equal(queue.size, entries.length);
  const remaining = entries.filter((entry, i) => {
    if (i % 3 !== 0) return true;
    assert.equal(queue.delete(entry), true);
    assert.equal(queue.delete(entry), false);
    return false;
  }).sort((a, b) => a.expiresAt - b.expiresAt);
  for (const expected of remaining) {
    const next = queue.peek()!;
    assert.equal(next.expiresAt, expected.expiresAt);
    assert.equal(queue.delete(next), true);
  }
  assert.equal(queue.size, 0);
  assert.equal(queue.peek(), undefined);
  for (const entry of entries) assert.equal(queue.delete(entry), false, 'no settled entry retains an index');
});

test('mass staggered expiry uses O(n log n) deadline comparisons, not repeated full scans', () => {
  const size = 20_000;
  let reads = 0;
  const queue = new ExpiryQueue<{ readonly expiresAt: number }>();
  // Descending insertion exercises heap promotion; one-by-one expiry exercises extraction.
  for (let deadline = size; deadline > 0; deadline--) {
    queue.add({ get expiresAt() { reads++; return deadline; } });
  }
  for (let expected = 1; expected <= size; expected++) {
    const next = queue.peek()!;
    assert.equal(next.expiresAt, expected);
    queue.delete(next);
  }
  assert.equal(queue.size, 0);
  assert.ok(reads < 16 * size * Math.ceil(Math.log2(size)), `${reads} deadline reads for ${size} entries`);
});
