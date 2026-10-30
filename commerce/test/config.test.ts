import assert from 'node:assert/strict';
import test from 'node:test';

import { PRODUCTION_ADDRESSES, productionAddress } from '../src/config.js';

test('production accepts only the normalized fixed public and provider addresses', () => {
  for (const [name, value] of Object.entries(PRODUCTION_ADDRESSES)) {
    assert.equal(
      productionAddress('PRODUCTION', name as keyof typeof PRODUCTION_ADDRESSES, value),
      value,
    );
  }

  assert.equal(
    productionAddress('PRODUCTION', 'COMMERCE_ORIGIN', 'https://BOOK.mikluha-maklai.ru:443/'),
    PRODUCTION_ADDRESSES.COMMERCE_ORIGIN,
  );
});

test('production rejects redirected or modified trust boundaries', () => {
  const rejectedHttps: Array<[keyof typeof PRODUCTION_ADDRESSES, string]> = [
    ['COMMERCE_ORIGIN', 'https://attacker.example'],
    ['SITE_ORIGIN', 'https://attacker.example'],
  ];

  for (const [name, value] of rejectedHttps) {
    // Regression control: every value passes the former HTTPS-only production check.
    assert.equal(new URL(value).protocol, 'https:');
    assert.throws(
      () => productionAddress('PRODUCTION', name, value),
      new RegExp(`CONFIG_PRODUCTION_ADDRESS_MISMATCH: ${name}`),
    );
  }
  assert.throws(
    () => productionAddress('PRODUCTION', 'COMMERCE_ORIGIN', 'http://book.mikluha-maklai.ru'),
    /CONFIG_PRODUCTION_ADDRESS_MISMATCH: COMMERCE_ORIGIN/,
  );
  assert.throws(
    () => productionAddress('PRODUCTION', 'COMMERCE_ORIGIN', 'not-a-url'),
    /CONFIG_INVALID: COMMERCE_ORIGIN/,
  );
});

test('staging keeps addresses configurable and returns the configured value unchanged', () => {
  assert.equal(productionAddress('STAGING', 'COMMERCE_ORIGIN', 'http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
});
