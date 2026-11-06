import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BookingRateLimiter } from '../src/rate-limit.js';

test('only exactly one valid forwarded IP is trusted', () => {
  assert.equal(BookingRateLimiter.clientIp({ 'x-forwarded-for': '203.0.113.7' }), '203.0.113.7');
  assert.equal(BookingRateLimiter.clientIp({ 'x-forwarded-for': '2001:db8::7' }), '2001:db8::7');
  for (const value of [undefined, '', 'unknown', '203.0.113.7, 10.0.0.1']) {
    assert.equal(BookingRateLimiter.clientIp(value === undefined ? {} : { 'x-forwarded-for': value }), null);
  }
});

test('missing, malformed and multiple forwarded values share the untrusted bucket', () => {
  const limiter = new BookingRateLimiter({ ipLimit: 2, windowMs: 60_000 });
  assert.equal(limiter.checkIp({}, 1_000).allowed, true);
  assert.equal(limiter.checkIp({ 'x-forwarded-for': 'bad' }, 1_001).allowed, true);
  const blocked = limiter.checkIp({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, 1_002);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 59);
});

test('keyed storage expires entries and never exceeds its configured bound', () => {
  const limiter = new BookingRateLimiter({ ipLimit: 1, windowMs: 100, maxKeyedBuckets: 2 });
  assert.equal(limiter.checkIp({ 'x-forwarded-for': '192.0.2.1' }, 1).allowed, true);
  assert.equal(limiter.checkIp({ 'x-forwarded-for': '192.0.2.2' }, 2).allowed, true);
  assert.equal(limiter.checkIp({ 'x-forwarded-for': '192.0.2.3' }, 3).allowed, true);
  assert.equal(limiter.checkIp({ 'x-forwarded-for': '192.0.2.4' }, 4).allowed, false);
  assert.equal(limiter.keyedBucketCount, 2);
  assert.equal(limiter.checkIp({ 'x-forwarded-for': '192.0.2.5' }, 200).allowed, true);
  assert.equal(limiter.keyedBucketCount, 1);
});

test('normalized email is an independent boundary', () => {
  const limiter = new BookingRateLimiter({ emailLimit: 2, windowMs: 60_000 });
  assert.equal(limiter.checkEmail(' Person@Example.RU ', 1_000).allowed, true);
  assert.equal(limiter.checkEmail('person@example.ru', 1_001).allowed, true);
  assert.equal(limiter.checkEmail('PERSON@example.ru', 1_002).allowed, false);
});

// TOUR-49 abuse scenarios: rotating addresses must not multiply capacity beyond the bounded store.
test('IP rotation cannot bypass the per-email boundary', () => {
  const limiter = new BookingRateLimiter({ ipLimit: 10, emailLimit: 3, windowMs: 60_000 });
  const results = Array.from({ length: 6 }, (_, i) => {
    const ip = limiter.checkIp({ 'x-forwarded-for': `198.51.100.${i + 1}` }, 1_000 + i).allowed;
    return ip && limiter.checkEmail('Flood@Example.RU', 1_000 + i).allowed;
  });
  assert.deepEqual(results, [true, true, true, false, false, false]);
});

test('a rotating-address flood beyond the keyed bound shares one limited overflow bucket', () => {
  const limiter = new BookingRateLimiter({ ipLimit: 2, windowMs: 60_000, maxKeyedBuckets: 3 });
  let allowed = 0;
  for (let i = 0; i < 200; i += 1) if (limiter.checkIp({ 'x-forwarded-for': `203.0.113.${(i % 250) + 1}` }, 1_000 + i).allowed) allowed += 1;
  // three keyed addresses get their first request; then every new address shares the 2-request overflow
  assert.equal(allowed, 3 + 2);
  assert.equal(limiter.keyedBucketCount, 3);
});

test('spoofed forwarding chains cannot mint fresh identities', () => {
  const limiter = new BookingRateLimiter({ ipLimit: 1, windowMs: 60_000 });
  const outcomes = ['198.51.100.1, 10.0.0.1', '198.51.100.2, 10.0.0.1', ' , ', 'not-an-ip', '1.2.3.4.5']
    .map((v, i) => limiter.checkIp({ 'x-forwarded-for': v }, 1_000 + i).allowed);
  assert.deepEqual(outcomes, [true, false, false, false, false]);
  assert.equal(limiter.keyedBucketCount, 0);
});
