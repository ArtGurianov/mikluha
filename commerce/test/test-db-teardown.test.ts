import assert from 'node:assert/strict';
import { test } from 'node:test';

import { freshDb } from './helpers.js';

test('test database teardown waits for pooled sockets before dropping the database', async () => {
  const db = await freshDb();
  const clients = await Promise.all(Array.from({ length: 10 }, () => db.pool.connect()));
  const errors: Error[] = [];
  const endings: Promise<void>[] = [];
  for (const client of clients) {
    client.on('error', error => errors.push(error));
    const end = client.end.bind(client);
    // Pool.end() can finish removing a client before its network close has completed.
    // Delay that close deterministically instead of depending on a busy CI runner's timing.
    client.end = ((callback?: () => void) => {
      const ending = new Promise<void>(resolve => {
        setTimeout(() => { void end(() => { callback?.(); resolve(); }); }, 100);
      });
      endings.push(ending);
      return ending;
    }) as typeof client.end;
    client.release();
  }
  await db.drop();
  await Promise.all(endings);
  assert.deepEqual(errors, [], 'DROP DATABASE must not terminate managed client sockets');
});


test('test database teardown reports a bounded timeout for a checked-out client', async () => {
  const db = await freshDb();
  const client = await db.pool.connect();
  let released = false;
  const release = () => { if (!released) { released = true; client.release(); } };
  // Keep the regression bounded even against the old unbounded helper.
  const rescue = setTimeout(release, 300);
  let timedOut = false;
  try {
    await assert.rejects(db.drop(50), /TEST_DATABASE_TEARDOWN_TIMEOUT.*runtime.*checkedOut=1/);
    timedOut = true;
  } finally {
    clearTimeout(rescue);
    release();
    if (timedOut) await db.drop();
  }
});
