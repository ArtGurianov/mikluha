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
    ['REFREF_API_BASE', 'https://attacker.example/v1-rc'],
    ['REFREF_API_BASE', 'https://api.refref.ru.attacker.example/v1-rc'],
    ['REFREF_API_BASE', 'https://api.refref.ru:444/v1-rc'],
    ['REFREF_API_BASE', 'https://api.refref.ru/v1-rc/'],
    ['REFREF_API_BASE', 'https://api.refref.ru/v1-rc?redirected=true'],
    ['REFREF_API_BASE', 'https://secret@api.refref.ru/v1-rc'],
    ['COMMERCE_ORIGIN', 'https://attacker.example'],
    ['SITE_ORIGIN', 'https://attacker.example'],
    ['REFREF_CHECKOUT_ORIGIN', 'https://attacker.example'],
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
    () => productionAddress('PRODUCTION', 'REFREF_API_BASE', 'http://api.refref.ru/v1-rc'),
    /CONFIG_PRODUCTION_ADDRESS_MISMATCH: REFREF_API_BASE/,
  );
  assert.throws(
    () => productionAddress('PRODUCTION', 'REFREF_API_BASE', 'not-a-url'),
    /CONFIG_INVALID: REFREF_API_BASE/,
  );
});

test('staging keeps addresses configurable and returns the configured value unchanged', () => {
  assert.equal(productionAddress('STAGING', 'REFREF_API_BASE', 'http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
});
