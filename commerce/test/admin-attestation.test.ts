import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { adminKeys, attest, auditEvidence, parseAuditKeys, type AttestedRow } from '../src/admin/attestation.js';

const oldKey = Buffer.alloc(32, 3);
const newKey = Buffer.alloc(32, 4);
const row: AttestedRow = { eventId: randomUUID(), keyId: 'old-1', loginRole: 'admin_runtime', adminId: randomUUID(),
  actor: 'owner', action: 'TOUR.PUBLISHED', outcome: 'OK', entityType: 'tour', entityId: randomUUID(), details: {} };

test('audit key rotation preserves history; lost historical key is UNVERIFIABLE', () => {
  const signature = attest(oldKey, row);
  const current = adminKeys(Buffer.alloc(32, 8), { id: 'new-2', key: newKey, previous: new Map([['old-1', oldKey]]) });
  assert.equal(auditEvidence(current, row, signature), 'ATTESTED');
  assert.equal(auditEvidence(current, { ...row, eventId: randomUUID() }, signature), 'FORGED');
  assert.equal(auditEvidence(current, { ...row, loginRole: 'admin_operator_login' }, signature), 'FORGED');
  assert.equal(auditEvidence(current, { ...row, keyId: 'new-2' }, signature), 'FORGED');
  const lost = adminKeys(Buffer.alloc(32, 9), { id: 'new-2', key: newKey });
  assert.equal(auditEvidence(lost, row, signature), 'UNVERIFIABLE');
  // Signing uses only the current key; the historic key is verification-only.
  assert.equal(current.auditKeyId, 'new-2');
  assert.equal(current.audit, newKey);
});

test('audit signing has no fallback to TOTP; malformed/missing active or historical keys refuse startup', () => {
  const env = { ADMIN_AUDIT_KEY_ID: 'new-2', ADMIN_AUDIT_KEY: newKey.toString('base64url'),
    ADMIN_AUDIT_PREVIOUS_KEYS: JSON.stringify({ 'old-1': oldKey.toString('base64url') }) };
  const keys = parseAuditKeys(env);
  assert.ok(keys.key.equals(newKey));
  assert.ok(keys.previous!.get('old-1')!.equals(oldKey));
  for (const invalid of [{}, { ...env, ADMIN_AUDIT_KEY: undefined }, { ...env, ADMIN_AUDIT_KEY_ID: '' },
    { ...env, ADMIN_AUDIT_KEY: 'short' }, { ...env, ADMIN_AUDIT_PREVIOUS_KEYS: '[]' },
    { ...env, ADMIN_AUDIT_PREVIOUS_KEYS: '{' }, { ...env, ADMIN_AUDIT_PREVIOUS_KEYS: JSON.stringify({ 'new-2': oldKey.toString('base64url') }) }]) {
    assert.throws(() => parseAuditKeys(invalid), /CONFIG_INVALID: ADMIN_AUDIT/);
  }
});
