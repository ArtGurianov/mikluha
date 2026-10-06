import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { freshDb, type TestDb } from './helpers.js';

let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });

test('the distributed processing instruction is DRAFT, with exact template identity and no invented signature', async () => {
  const { rows } = await db.pool.query('SELECT * FROM processing_instruction');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.document_ref, 'pd-processing-instruction-refref-v1');
  assert.equal(r.version, '1.0');
  assert.equal(r.processor_ref, 'refref');
  assert.equal(r.status, 'DRAFT');
  for (const field of ['signed_at', 'effective_at', 'sha256', 'signed_document_ref']) assert.equal(r[field], null);
  assert.equal(r.template_sha256, `sha256:${createHash('sha256').update(
    readFileSync(new URL('../legal/pd-processing-instruction-refref-v1.md', import.meta.url))).digest('hex')}`);
});

test('runtime and operator can read but cannot attest or replace processing evidence', async () => {
  for (const role of [db.pool, db.operator]) {
    assert.equal((await role.query('SELECT status FROM processing_instruction')).rows[0].status, 'DRAFT');
    for (const sql of ["UPDATE processing_instruction SET status = 'SIGNED'", 'DELETE FROM processing_instruction',
      "INSERT INTO processing_instruction SELECT * FROM processing_instruction"]) {
      await assert.rejects(role.query(sql), (e: unknown) => (e as { code?: string }).code === '42501');
    }
  }
});

test('even the owner cannot record incomplete or chronology-invalid signed evidence', async () => {
  for (const clause of ["status = 'SIGNED'", "signed_at = '2026-10-06'",
    "status = 'SIGNED', signed_at = '2026-10-06', effective_at = '2026-10-05', sha256 = 'sha256:" + 'a'.repeat(64) + "', signed_document_ref = 'owner-store:synthetic-test'"]) {
    await assert.rejects(db.owner.query(`UPDATE processing_instruction SET ${clause}`),
      (e: unknown) => (e as { code?: string }).code === '23514');
  }
});
