// Run only in the recovered DB's network namespace, using the canonical image's crypto exports.
// Key JSON is a separately retrieved off-host generation, not part of the DB dump. Never print it.
import fs from 'node:fs';
import pg from '/app/commerce/node_modules/pg/lib/index.js';
import { adminKeys, parseAuditKeys, auditEvidence } from '/app/commerce/dist/admin/attestation.js';
import { parseTotpKey, decryptSeed } from '/app/commerce/dist/admin/totp.js';
const supplied = JSON.parse(fs.readFileSync('/run/restore-keys.json', 'utf8'));
if (supplied.generation !== process.env.EXPECTED_SECRET_GENERATION) throw Error('KEY_GENERATION_MISMATCH');
const totp = parseTotpKey(supplied.ADMIN_TOTP_KEY);
const keys = adminKeys(totp, parseAuditKeys(supplied));
const pool = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/mikluha', max: 1 });
try {
  const rows = (await pool.query(`SELECT event_id AS "eventId",key_id AS "keyId",login_role AS "loginRole",
    admin_id AS "adminId",actor,action,outcome,entity_type AS "entityType",entity_id AS "entityId",details,attestation
    FROM admin_audit ORDER BY id`)).rows;
  const statuses = { ATTESTED: 0, FORGED: 0, UNVERIFIABLE: 0, OPERATOR: 0 };
  for (const { attestation, ...row } of rows) statuses[auditEvidence(keys, row, attestation)]++;
  if (statuses.FORGED || statuses.UNVERIFIABLE) throw Error('AUDIT_NOT_VERIFIABLE');
  const seeds = (await pool.query('SELECT admin_id,seed_ciphertext FROM admin_totp')).rows;
  for (const row of seeds) {
    const seed = decryptSeed(totp, row.admin_id, row.seed_ciphertext);
    if (!seed.length) throw Error('SEED_EMPTY');
    let rejected = false;
    try { decryptSeed(Buffer.alloc(32), row.admin_id, row.seed_ciphertext); } catch { rejected = true; }
    if (!rejected) throw Error('WRONG_KEY_ACCEPTED');
    rejected = false;
    try { decryptSeed(totp, 'incorrect-account', row.seed_ciphertext); } catch { rejected = true; }
    if (!rejected) throw Error('WRONG_ACCOUNT_ACCEPTED');
  }
  const hasData = statuses.ATTESTED > 0 && seeds.length > 0;
  if (process.env.RESTORE_SCOPE === 'acceptance' && !hasData) throw Error('SYNTHETIC_CRYPTO_ROWS_REQUIRED');
  console.log(JSON.stringify({admin_crypto: hasData ? 'PASS' : 'EMPTY_WORKING_GENERATION_KEYS_LOADED',
    statuses, totp_rows: seeds.length, private_key_values_logged: false,
    key_origin: 'OPERATOR_SUPPLIED_REQUIRES_SEPARATE_OFFHOST_RECEIPT'}));
} finally { await pool.end(); }
