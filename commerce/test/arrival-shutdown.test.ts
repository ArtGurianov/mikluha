import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { AfterResponse, Arrivals, newContextId } from '../src/arrival.js';
import { SchemaAdmission } from '../src/schema-admission.js';

const response = () => new ServerResponse(new IncomingMessage(new Socket()));
const proof = (n: number) => `ar1.${String(n).padStart(43, 'x')}`;
const receipt = { kind: 'ANSWERED' as const, status: 201, body: {
  claimId: 'test', browserContextId: 'test', storefrontOrigin: 'https://book.example.invalid',
  claimedAt: '2026-10-23T00:00:00Z', eligibleUntil: '2026-11-22T00:00:00Z',
} };

for (const compatible of [true, false]) {
  test(`SIGTERM before response close: registered arrival ${compatible ? 'claims once before exit' : 'still refuses incompatible schema'}`, async () => {
    let schemaReady = true, schemaChecks = 0, sends = 0, completed = false;
    const admission = new SchemaAdmission(async () => {
      schemaChecks++;
      return schemaReady ? { status: 'READY' } : { status: 'NOT_READY', reason: 'SCHEMA_AHEAD_INCOMPATIBLE' };
    });
    const after = new AfterResponse(admission);
    const arrivals = new Arrivals({ after, storefrontOrigin: 'https://book.example.invalid', log: () => {},
      refref: { claimArrival: async () => { sends++; return receipt; } } });
    const id = newContextId(), res = response();
    arrivals.capture(id, proof(1)); arrivals.afterResponse(res, id);
    assert.equal(after.pending, 1, 'task is tracked before response close');
    let draining: Promise<void> | undefined;
    const stop = () => {
      after.stop();
      draining = Promise.all([admission.drain(), after.drain()]).then(() => { completed = true; });
    };
    process.once('SIGTERM', stop);
    try {
      process.kill(process.pid, 'SIGTERM');
      while (!draining) await tick();
      assert.equal(completed, false); assert.equal(sends, 0);
      assert.equal((await admission.run(async () => { sends++; })).reason, 'RUNTIME_DRAINING');
      const late = response(); after.schedule(late, async () => { sends++; }); late.emit('close');
      schemaReady = compatible;
      res.emit('close'); await draining;
      res.emit('close'); await tick();
      assert.equal(schemaChecks, 1, 'live compatibility check runs when the registered task starts');
      assert.equal(sends, compatible ? 1 : 0); assert.equal(after.pending, 0); assert.equal(completed, true);
      assert.equal(arrivals.hasPending(id), !compatible);
    } finally { process.removeListener('SIGTERM', stop); res.emit('close'); await draining; }
  });
}

test('proof captured while a registered claim is in flight finishes in the same shutdown obligation', async () => {
  const admission = new SchemaAdmission(async () => ({ status: 'READY' }));
  const after = new AfterResponse(admission);
  let release!: () => void, sends = 0;
  const blocked = new Promise<void>(r => { release = r; });
  const arrivals = new Arrivals({ after, storefrontOrigin: 'https://book.example.invalid', log: () => {},
    refref: { claimArrival: async () => { sends++; if (sends === 1) await blocked; return receipt; } } });
  const id = newContextId(), first = response(), second = response();
  arrivals.capture(id, proof(1)); arrivals.afterResponse(first, id); first.emit('close');
  while (sends === 0) await tick();
  arrivals.capture(id, proof(2)); arrivals.afterResponse(second, id);
  after.stop();
  const stopped = admission.drain();
  second.emit('close'); release(); await stopped; await after.drain();
  assert.equal(sends, 2); assert.equal(arrivals.hasPending(id), false); assert.equal(after.pending, 0);
});

for (const compatible of [true, false]) {
  test(`in-flight admitted HTTP request registers after SIGTERM; live schema ${compatible ? 'allows claim' : 'refuses claim'}`, async () => {
    let schemaReady = true, sends = 0;
    const admission = new SchemaAdmission(async () => schemaReady ? { status: 'READY' } : { status: 'NOT_READY', reason: 'SCHEMA_AHEAD_INCOMPATIBLE' });
    const after = new AfterResponse(admission);
    const arrivals = new Arrivals({ after, storefrontOrigin: 'https://book.example.invalid', log: () => {},
      refref: { claimArrival: async () => { sends++; return receipt; } } });
    const id = newContextId(), res = response();
    let entered!: () => void, continueRequest!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const resume = new Promise<void>(r => { continueRequest = r; });
    const request = admission.runRequest(async () => {
      entered(); await resume;
      arrivals.capture(id, proof(1)); arrivals.afterResponse(res, id);
    });
    await started;
    let draining: Promise<void> | undefined, completed = false;
    const stop = () => { after.stop(); draining = admission.drain().then(() => { completed = true; }); };
    process.once('SIGTERM', stop);
    try {
      process.kill(process.pid, 'SIGTERM'); while (!draining) await tick();
      assert.equal((await admission.runRequest(async () => { sends++; })).reason, 'RUNTIME_DRAINING');
      // A different async context cannot borrow the live request's permission.
      const foreign = response(); after.schedule(foreign, async () => { sends++; }); foreign.emit('close');
      continueRequest(); await request;
      assert.equal(after.pending, 1); assert.equal(completed, false);
      schemaReady = compatible; res.emit('close'); await draining; await after.drain();
      assert.equal(sends, compatible ? 1 : 0); assert.equal(completed, true);
    } finally { process.removeListener('SIGTERM', stop); continueRequest(); res.emit('close'); await request; await draining; }
  });
}

test('detached descendants cannot register after their admitted request has returned', async () => {
  const admission = new SchemaAdmission(async () => ({ status: 'READY' }));
  const after = new AfterResponse(admission);
  let release!: () => void, sends = 0;
  const later = new Promise<void>(r => { release = r; });
  let detached!: Promise<void>;
  await admission.runRequest(async () => {
    detached = later.then(() => {
      const res = response(); after.schedule(res, async () => { sends++; }); res.emit('close');
    });
  });
  after.stop(); const draining = admission.drain();
  release(); await detached; await draining; await after.drain();
  assert.equal(sends, 0); assert.equal(after.pending, 0);
});
