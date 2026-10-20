// Admin TOTP (ADR v2.3 §7): RFC 6238 Appendix B (SHA-1) and RFC 4226 Appendix D vectors, the ±1
// step window, and the seed encryption. The same vectors as Flexperiment and Refref.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  base32Decode, base32Encode, decryptSeed, encryptSeed, hotp, matchingStep, newSeed, parseTotpKey, totp, totpStep,
} from '../src/admin/totp.js';

const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');

test('RFC 6238 Appendix B, SHA-1, 8 digits', () => {
  const vectors: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [seconds, code] of vectors) assert.equal(totp(RFC_SEED, new Date(seconds * 1000), 8), code, `T=${seconds}`);
});

test('RFC 4226 Appendix D, 6 digits: what an authenticator app shows', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(hotp(RFC_SEED, counter), code));
  assert.equal(totp(RFC_SEED, new Date(59_000)), '287082');
});

test('a code is accepted one step either side and no further', () => {
  const at = new Date('2026-10-19T12:00:15Z');
  const step = totpStep(at);
  for (const d of [-1, 0, 1]) assert.equal(matchingStep(RFC_SEED, hotp(RFC_SEED, step + d), at), step + d);
  for (const d of [-3, -2, 2, 3]) assert.equal(matchingStep(RFC_SEED, hotp(RFC_SEED, step + d), at), undefined);
  for (const bad of ['', '12345', '1234567', 'abcdef', 123456, null, undefined]) assert.equal(matchingStep(RFC_SEED, bad, at), undefined);
});

test('base32 round trip and the otpauth URI', () => {
  assert.equal(base32Encode(RFC_SEED), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), RFC_SEED);
  const { seed, secret, otpauthUri } = newSeed('owner');
  assert.equal(seed.length, 20);
  assert.deepEqual(base32Decode(secret), seed);
  assert.equal(otpauthUri, `otpauth://totp/Mikluha%3Aowner?secret=${secret}&issuer=Mikluha&algorithm=SHA1&digits=6&period=30`);
});

test('the seed is encrypted, bound to its account, and needs the exact key', () => {
  const key = Buffer.alloc(32, 7);
  const sealed = encryptSeed(key, 'a', RFC_SEED);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes(base32Encode(RFC_SEED)) && !sealed.includes(RFC_SEED.toString('base64url')));
  assert.deepEqual(decryptSeed(key, 'a', sealed), RFC_SEED);
  assert.throws(() => decryptSeed(key, 'b', sealed), /TOTP_SEED_INVALID/);
  assert.throws(() => decryptSeed(Buffer.alloc(32, 8), 'a', sealed), /TOTP_SEED_INVALID/);
  assert.equal(parseTotpKey(key.toString('base64url')).length, 32);
  for (const bad of [undefined, '', Buffer.alloc(16).toString('base64url'), `${key.toString('base64url')}=`]) {
    assert.throws(() => parseTotpKey(bad), /ADMIN_TOTP_KEY/);
  }
});
