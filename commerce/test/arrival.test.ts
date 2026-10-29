// The deferred Arrival library (Refref docs/29 §2, §4, §6, §8; ART-382) against a model of Refref's
// vNext claimArrival. Under NATIVE_NO_REFERRAL nothing in the service wires it (native-ingress.test.ts
// proves /arrive is inert); these tests keep the prior contract honest for the referral profile.
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  ATTEMPT_CEILING_MS, arrivalTarget, Arrivals, BUY_BUDGET_MS, CONTEXT_COOKIE, CONTEXT_MAX_AGE_SECONDS, contextCookie,
  MAX_ACTIVE_CLAIMS, newContextId, RETRY_INTERVAL_MS, validContextId,
} from '../src/arrival.js';
import { RefrefClient } from '../src/refref.js';
import { FakeVnext } from './fake-vnext.js';
import { captureLog } from './helpers.js';

const COMMERCE = 'https://book.mikluha.example';
const SITE = 'https://mikluha.example';
const MINUTE = 60_000;

let vnext: FakeVnext;
let clock: Date;
let logs: ReturnType<typeof captureLog>;
let arrivals: Arrivals;

const response = () => new ServerResponse(new IncomingMessage(new Socket()));

/** What a request of this context did before TOUR-81: optionally keep a proof, then retry after the response. */
function request(a: Arrivals, id: string, proof?: string): void {
  if (proof !== undefined) a.capture(id, proof);
  const res = response();
  a.afterResponse(res, id);
  res.emit('close');
}

before(async () => {
  vnext = new FakeVnext(COMMERCE);
  vnext.now = () => clock.getTime();
  await vnext.start();
  logs = captureLog();
  arrivals = new Arrivals({ refref: new RefrefClient({ apiBase: vnext.base, apiKey: 'rk_test', timeoutMs: ATTEMPT_CEILING_MS }),
    storefrontOrigin: COMMERCE, log: logs.log, now: () => clock });
});
after(async () => {
  await arrivals.after.drain();
  await vnext.stop();
});
beforeEach(async () => {
  clock = new Date('2026-10-04T06:00:00Z');
  await arrivals.after.drain();
  vnext.reset();
  logs.lines.length = 0;
});

describe('browser context and arrival', () => {
  test('the context cookie is host-only, 30 days, and carries 32 random bytes', () => {
    const id = newContextId();
    assert.ok(validContextId(id));
    const attrs = contextCookie(id).split(';').map((a) => a.trim());
    assert.equal(attrs[0], `${CONTEXT_COOKIE}=${id}`);
    assert.deepEqual(attrs.slice(1).sort(), ['HttpOnly', `Max-Age=${CONTEXT_MAX_AGE_SECONDS}`, 'Path=/', 'SameSite=Lax', 'Secure']);
    assert.equal(CONTEXT_MAX_AGE_SECONDS, 30 * 24 * 3600);
  });

  test('after the response the proof is claimed with only the proof, the context and this origin', async () => {
    const proof = vnext.issue();
    const id = newContextId();
    request(arrivals, id, proof);
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 1, 'the mandatory after-response attempt was made');
    assert.deepEqual(vnext.requests[0]!.body, { arrivalProof: proof, browserContextId: id, storefrontOrigin: COMMERCE });
    assert.equal(vnext.requests[0]!.path, '/v1-vnext/integrations/arrival-claims');
    assert.deepEqual(await arrivals.beforeBuy(id), { degraded: false });
    for (const line of logs.lines) {
      assert.ok(!line.includes(proof), 'no proof in logs');
      assert.ok(!line.includes(id), 'no context ID in logs');
    }
  });

  test('an arrival burst keeps actual outgoing HTTP concurrency bounded', async () => {
    // Give this load test its own transport/server so aborted sockets cannot reach another test.
    const fake = new FakeVnext(COMMERCE);
    await fake.start();
    fake.next = Array.from({ length: 200 }, () => 'HANG');
    const loaded = new Arrivals({ refref: new RefrefClient({ apiBase: fake.base, apiKey: 'rk_test' }),
      storefrontOrigin: COMMERCE, log: logs.log });
    try {
      const ids = Array.from({ length: 100 }, () => newContextId());
      for (const id of ids) request(loaded, id, fake.issue());
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(fake.active > 0, 'outgoing claims are hung');
      await loaded.after.drain();
      assert.ok(fake.peak <= MAX_ACTIVE_CLAIMS, `peak actual HTTP concurrency: ${fake.peak}`);
      assert.ok(logs.lines.some((l) => l.includes('OVERLOADED')), 'overflow is explicit');
      for (const id of ids) assert.deepEqual(loaded.degradation(id), { degraded: true, reason: 'TIMEOUT' });
    } finally {
      await loaded.after.drain();
      await fake.stop();
    }
  });

  test('a known context is reused; a missing or foreign cookie gets a new one', () => {
    const id = newContextId();
    assert.deepEqual(arrivals.resolveContext(id), { id, isNew: false, rotated: false });
    for (const cookie of [undefined, 'short', `${id}x`]) {
      const c = arrivals.resolveContext(cookie);
      assert.ok(c.isNew && !c.rotated && c.id !== id && validContextId(c.id));
    }
  });

  test('redirects only to the public site', () => {
    const home = `${SITE}/`;
    for (const to of [null, '', 'https://evil.example/', '//evil.example/x', '/\\evil.example', '\\\\evil.example',
      'javascript:alert(1)', '/%0d%0aSet-Cookie:x=1'.replace('%0d%0a', '\r\n'), '/a\tb', 'tours/altai', `/${'a'.repeat(600)}`,
      'http://mikluha.example/', 'https://user:pw@mikluha.example/']) {
      assert.equal(arrivalTarget(SITE, to), home, String(to));
    }
    assert.equal(arrivalTarget(SITE, '/tours/altai/'), `${SITE}/tours/altai/`);
    assert.equal(arrivalTarget(SITE, '/%2F%2Fevil.example'), `${SITE}/%2F%2Fevil.example`);
    assert.equal(arrivalTarget(SITE, '/tours/?arrival=x&Arrival=y&ok=1#d'), `${SITE}/tours/?ok=1#d`);
  });
});

describe('exchange and retry', () => {
  test('a failed first attempt is retried after the next same-context request and confirms the claim', async () => {
    const proof = vnext.issue();
    vnext.next = ['ERROR_500'];
    const id = newContextId();
    request(arrivals, id, proof);
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 1);
    assert.deepEqual(arrivals.degradation(id), { degraded: true, reason: 'TIMEOUT' });

    // Within the throttle window a request shares the previous attempt.
    request(arrivals, id);
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 1);

    clock = new Date(clock.getTime() + RETRY_INTERVAL_MS);
    request(arrivals, id);
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 2);
    assert.deepEqual(vnext.requests[1]!.body, vnext.requests[0]!.body, 'the retry is the identical claim');
    assert.equal(vnext.claims.get(proof), id);
    assert.deepEqual(arrivals.degradation(id), { degraded: false });

    clock = new Date(clock.getTime() + RETRY_INTERVAL_MS);
    request(arrivals, id);
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 2, 'nothing left to claim');
  });

  test('a claim nobody retried within 30 minutes expires and is never rescued later', async () => {
    vnext.next = ['ERROR_500'];
    const id = newContextId();
    request(arrivals, id, vnext.issue());
    await arrivals.after.drain();
    clock = new Date(clock.getTime() + 31 * MINUTE);
    request(arrivals, id);
    await arrivals.after.drain();
    assert.equal(vnext.requests.length, 1, 'no claim after the deadline');
    assert.deepEqual(await arrivals.beforeBuy(id), { degraded: true, reason: 'EXPIRED' });
    assert.ok(logs.lines.some((l) => JSON.parse(l).event === 'arrival_claim_expired'));
  });

  test('before Buy: a hanging Refref costs at most 1,500 ms and is declared TIMEOUT; a refusal is FAILED', async () => {
    vnext.next = ['ERROR_500', 'HANG', 'HANG', 'HANG', 'HANG', 'HANG'];
    const id = newContextId();
    request(arrivals, id, vnext.issue());
    await arrivals.after.drain();
    const started = Date.now();
    assert.deepEqual(await arrivals.beforeBuy(id), { degraded: true, reason: 'TIMEOUT' });
    const spent = Date.now() - started;
    assert.ok(spent >= BUY_BUDGET_MS - 100 && spent < BUY_BUDGET_MS + 400, `spent ${spent} ms`);

    vnext.reset();
    const refused = newContextId();
    request(arrivals, refused, 'ar1.'.padEnd(47, 'z'));
    await arrivals.after.drain();
    assert.deepEqual(await arrivals.beforeBuy(refused), { degraded: true, reason: 'FAILED' });
    assert.equal(vnext.requests.length, 1, 'a definitive refusal is not repeated');
  });

  test('a lost ACK on a committed claim is recovered by the identical repeat', async () => {
    const proof = vnext.issue();
    const id = newContextId();
    request(arrivals, id, proof);
    await arrivals.after.drain();
    // The first answer was lost by the merchant (simulated by a second process memory).
    const other = new Arrivals({ refref: new RefrefClient({ apiBase: vnext.base, apiKey: 'rk_test' }), storefrontOrigin: COMMERCE,
      log: () => undefined, now: () => clock });
    other.capture(id, proof);
    assert.deepEqual(await other.beforeBuy(id), { degraded: false });
    assert.equal(vnext.requests.length, 2);
  });

  test('a context Refref refuses is replaced and never presented again; its unconfirmed proof follows the browser', async () => {
    const proof = vnext.issue();
    const id = newContextId();
    request(arrivals, id, vnext.issue());
    await arrivals.after.drain();
    vnext.closed.add(id);
    request(arrivals, id, proof);
    await arrivals.after.drain();
    const rotated = arrivals.resolveContext(id);
    assert.ok(rotated.rotated && rotated.id !== id, 'a new context');
    clock = new Date(clock.getTime() + RETRY_INTERVAL_MS);
    request(arrivals, rotated.id);
    await arrivals.after.drain();
    assert.equal(vnext.claims.get(proof), rotated.id);
    assert.equal(vnext.requests.filter((q) => q.body.browserContextId === id).length, 2);
    assert.equal(logs.lines.filter((l) => JSON.parse(l).event === 'browser_context_rotated').length, 1);
    // A second tab still sending the refused cookie joins the same replacement, never the old ID.
    assert.equal(arrivals.resolveContext(id).id, rotated.id);
    assert.equal(vnext.requests.filter((q) => q.body.browserContextId === id).length, 2);
  });
});

test('without a vNext API a captured proof stays undelivered and Buy declares it', async () => {
  const offline = new Arrivals({ refref: null, storefrontOrigin: COMMERCE, log: () => undefined, now: () => clock });
  offline.capture('a'.repeat(43), vnext.issue());
  assert.deepEqual(await offline.beforeBuy('a'.repeat(43)), { degraded: true, reason: 'TIMEOUT' });
});
