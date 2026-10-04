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
