import assert from 'node:assert/strict';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import {
  Arrivals, ATTEMPT_CEILING_MS, BUY_BUDGET_MS, CLAIM_TTL_MS, MAX_ACTIVE_CLAIMS, MAX_QUEUED_CLAIMS, newContextId,
} from '../src/arrival.js';
import type { ArrivalClaimer } from '../src/arrival.js';
import type { ArrivalClaimReceipt, RefrefResult } from '../src/refref.js';

const origin = 'https://book.mikluha.example';
const unknown = { kind: 'UNKNOWN', cause: 'TRANSPORT' } as const;
const confirmed: RefrefResult<ArrivalClaimReceipt> = { kind: 'ANSWERED', status: 201, body: {
  claimId: 'test', browserContextId: 'test', storefrontOrigin: origin,
  claimedAt: '2026-10-19T00:00:00Z', eligibleUntil: '2026-11-18T00:00:00Z',
} };
const proof = (n: number) => `ar1.${String(n).padStart(43, 'x')}`;

function blockedClaimer() {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const releases: (() => void)[] = [];
  const refref: ArrivalClaimer = { claimArrival: async () => {
    active++; calls++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return confirmed;
  } };
  return { refref, releases, get peak() { return peak; }, get calls() { return calls; } };
}

// This accessor deliberately reads actual retained raw fields without invoking lazy expiry.
test('pending raw proof is erased by the timer at TTL without any further request or degradation read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-10-19T00:00:00Z') });
  const a = new Arrivals({ refref: { claimArrival: async () => unknown }, storefrontOrigin: origin, log: () => {} });
  const id = newContextId();
  a.capture(id, proof(1));
  await a.attempt(id, 500, false);
  assert.equal(a.retainedRawProofs, 1);
  t.mock.timers.tick(60_000);
  a.capture(id, proof(2));
  t.mock.timers.tick(CLAIM_TTL_MS - 60_000);
  assert.equal(a.retainedRawProofs, 1, 'the first raw field was cleared, not only marked by a read');
  t.mock.timers.tick(60_000);
  assert.equal(a.retainedRawProofs, 0, 'the timer rearmed for the later proof');
  assert.deepEqual(a.degradation(id), { degraded: true, reason: 'EXPIRED' });
});

test('global concurrency and FIFO are bounded, overload remains degraded and can retry', async () => {
  const blocked = blockedClaimer();
  const events: string[] = [];
  const a = new Arrivals({ refref: blocked.refref, storefrontOrigin: origin, log: (e) => { events.push(e); } });
  const size = MAX_ACTIVE_CLAIMS + MAX_QUEUED_CLAIMS + 20;
  const ids = Array.from({ length: size }, () => newContextId());
  const jobs = ids.map((id, i) => { a.capture(id, proof(i)); return a.attempt(id, 500, false); });
  await tick();
  assert.equal(blocked.calls, MAX_ACTIVE_CLAIMS);
  assert.equal(blocked.peak, MAX_ACTIVE_CLAIMS);
  // Same-context calls share the exact promise; they do not create retry chains or queue entries.
  a.capture(ids[0]!, proof(1000));
  for (let i = 0; i < 1000; i++) assert.equal(a.attempt(ids[0]!, 500, false), jobs[0]);
  const overflow = ids.at(-1)!;
  assert.deepEqual(await a.beforeBuy(overflow, 0), { degraded: true, reason: 'TIMEOUT' });
  // Drain admitted work in waves. The newly captured proof gets just one tracked follow-up.
  for (let i = 0; i < size; i++) { blocked.releases.splice(0).forEach((release) => release()); await tick(); }
  await Promise.all(jobs);
  await a.after.drain();
  assert.equal(blocked.peak, MAX_ACTIVE_CLAIMS);
  assert.equal(blocked.calls, MAX_ACTIVE_CLAIMS + MAX_QUEUED_CLAIMS + 1, 'one tracked follow-up for the newly captured proof');
  const retry = a.attempt(overflow, 500, true);
  await tick();
  blocked.releases.splice(0).forEach((release) => release());
  await retry;
  assert.deepEqual(a.degradation(overflow), { degraded: false });
  assert.ok(events.includes('arrival_claim_unknown'));
});

test('queue admission expires within the attempt ceiling and never sends stale queued work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const blocked = blockedClaimer();
  const a = new Arrivals({ refref: blocked.refref, storefrontOrigin: origin, log: () => {} });
  const ids = Array.from({ length: MAX_ACTIVE_CLAIMS + MAX_QUEUED_CLAIMS }, () => newContextId());
  const jobs = ids.map((id, i) => { a.capture(id, proof(i)); return a.attempt(id, 500, false); });
  await tick();
  t.mock.timers.tick(ATTEMPT_CEILING_MS);
  await tick();
  assert.equal(blocked.calls, MAX_ACTIVE_CLAIMS);
  blocked.releases.splice(0).forEach((release) => release());
  await Promise.all(jobs);
  assert.equal(blocked.calls, MAX_ACTIVE_CLAIMS, 'expired queue entries never reach transport');
  assert.deepEqual(a.degradation(ids.at(-1)!), { degraded: true, reason: 'TIMEOUT' });
});

test('Buy deadline includes a shared in-flight attempt and a new arrival near the cutoff; late ACK stays frozen', async () => {
  const blocked = blockedClaimer();
  const a = new Arrivals({ refref: blocked.refref, storefrontOrigin: origin, log: () => {} });
  const id = newContextId();
  a.capture(id, proof(1));
  const flight = a.attempt(id, 500, false);
  await tick();
  const start = performance.now();
  const buy = a.beforeBuy(id, 100);
  await sleep(70);
  a.capture(id, proof(2));
  blocked.releases.splice(0).forEach((release) => release());
  await flight;
  const frozen = await buy;
  const spent = performance.now() - start;
  assert.deepEqual(frozen, { degraded: true, reason: 'TIMEOUT' });
  assert.ok(spent >= 90 && spent < 200, `shared attempt exceeded Buy deadline: ${spent}ms`);
  blocked.releases.splice(0).forEach((release) => release());
  await a.after.drain();
  assert.deepEqual(a.degradation(id), { degraded: false });
  assert.deepEqual(frozen, { degraded: true, reason: 'TIMEOUT' });
});

test('default Buy budget also bounds an existing transport that outlives its own ceiling', async () => {
  const blocked = blockedClaimer();
  const a = new Arrivals({ refref: blocked.refref, storefrontOrigin: origin, log: () => {} });
  const id = newContextId();
  a.capture(id, proof(1));
  const flight = a.attempt(id, 500, false);
  await tick();
  const start = performance.now();
  assert.deepEqual(await a.beforeBuy(id), { degraded: true, reason: 'TIMEOUT' });
  assert.ok(performance.now() - start < BUY_BUDGET_MS + 150);
  blocked.releases.splice(0).forEach((release) => release());
  await flight;
});

for (const [status, code] of [[409, 'BROWSER_CONTEXT_IDLE_POLICY_REQUIRED'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN']] as const) {
  test(`permanent ${status}/${code} is FAILED once with a credential-free operator signal`, async () => {
    let calls = 0;
    const logs: string[] = [];
    const a = new Arrivals({ refref: { claimArrival: async () => {
      calls++;
      return { kind: 'ANSWERED', status, body: { error: { code } } as unknown as ArrivalClaimReceipt };
    } }, storefrontOrigin: origin, log: (e, fields) => { logs.push(JSON.stringify({ event: e, ...fields })); } });
    const id = newContextId();
    const raw = proof(1);
    a.capture(id, raw);
    assert.deepEqual(await a.beforeBuy(id), { degraded: true, reason: 'FAILED' });
    await a.attempt(id, 500, true);
    assert.equal(calls, 1);
    assert.equal(a.retainedRawProofs, 0);
    assert.ok(logs.some((line) => line.includes('arrival_claim_configuration_failed') && line.includes(code)));
    assert.ok(logs.every((line) => !line.includes(raw) && !line.includes(id)));
  });
}

// An overdue timer alone is insufficient: microtasks from the earlier callback run first.
test('an ACK processed after the cutoff cannot clear degradation even if the deadline timer is delayed', async () => {
  const blocked = blockedClaimer();
  const a = new Arrivals({ refref: blocked.refref, storefrontOrigin: origin, log: () => {} });
  const id = newContextId();
  a.capture(id, proof(1));
  const flight = a.attempt(id, 500, false);
  await tick();
  const buy = a.beforeBuy(id, 100);
  await sleep(50);
  const unblockAt = performance.now() + 80;
  while (performance.now() < unblockAt) { /* simulate a busy event loop across the deadline */ }
  blocked.releases.splice(0).forEach((release) => release());
  await flight;
  assert.deepEqual(await buy, { degraded: true, reason: 'TIMEOUT' });
  assert.deepEqual(a.degradation(id), { degraded: false }, 'the next Buy can use the later confirmation');
});
