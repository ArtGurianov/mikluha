import assert from 'node:assert/strict';
import test from 'node:test';

import { productionAddress, requireHttps } from '../src/config.js';

test('production refuses every non-HTTPS public or provider address', () => {
  for (const value of ['http://api.example/v1', 'ftp://api.example', 'not-a-url']) {
    assert.throws(() => productionAddress('PRODUCTION', 'REFREF_API_BASE', value), /CONFIG_(HTTPS_REQUIRED|INVALID)/);
  }
  assert.equal(requireHttps('COMMERCE_ORIGIN', 'https://book.example'), 'https://book.example');
  assert.equal(productionAddress('STAGING', 'REFREF_API_BASE', 'http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
});
