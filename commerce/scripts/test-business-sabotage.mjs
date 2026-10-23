// ART-327: remove real guards in disposable copies, never in the checkout or a running service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// No implicit database and no remotely reachable endpoint. This is a superuser disposable server.
assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must explicitly name a disposable loopback PostgreSQL server');
const database = new URL(process.env.TEST_DATABASE_URL);
assert.ok(['postgres:', 'postgresql:'].includes(database.protocol)
  && ['127.0.0.1', '[::1]', 'localhost'].includes(database.hostname), 'Only loopback test PostgreSQL is allowed');
assert.ok(!database.search, 'Connection overrides are not allowed');

const checkout = 'src/checkout.ts';
const edit = (file, from, to) => ({ file, from, to });
// Every anchor must occur exactly once; drift is a hard failure, never a skipped mutation.
const mutants = [
  ['BI01', 'sales shared lock', [edit('migrations/0001_orders.sql', 'SELECT open FROM sales_switch FOR SHARE', 'SELECT open FROM sales_switch')]],
  ['BI01', 'session sales admission', [edit(checkout, "if (rows[0]?.open !== true) return 'SALES_CLOSED';", 'if (false) {}')]],
  ['BI02', 'freeze sales check', [edit(checkout, "if (!open) return { kind: 'STATUS', code: 'SALES_CLOSED' };", 'if (false) {}')]],
  ['BI03', 'departure capacity lock', [edit('src/orders.ts', "SELECT fn_lock_checkout_departure($1) AS id", "SELECT id FROM departure WHERE slug=$1")]],
  ['BI04', 'stable attempt identity', [edit(checkout, '`mk-attempt:${o.order_ref}`', "`mk-attempt:${o.order_ref}:${randomBytes(4).toString('hex')}`")]],
  ['BI05', 'fulfilment ACK admission', [edit(checkout, "if (ack.kind === 'ANSWERED' && ack.status === 200 && deliveredAcknowledgment(ack.body, attemptId))", 'if (true)')]],
  ['BI05', 'confirmation compare-and-set result', [edit(checkout, "if (changed.rowCount !== 1) { await client.query('ROLLBACK'); return false; }", 'if (false) {}')]],
  ['BI06', 'live legal admission', [edit(checkout, "if (o.status==='RESERVED' && deps.legalAdmission!==undefined)", 'if (false)')]],
  ['BI07', 'accepted document hash', [edit(checkout, 'if (zayavka.sha256 !== acceptedZayavka)', 'if (false)')]],
  ['BI08', 'browser state binding', [edit(checkout, '!sameSecret(cookie,q.state)', 'false')]],
  ['BI09', 'resolved merchant order binding', [edit(checkout, 'res.merchantOrderRef !== o.order_ref || ', '')]],
  ['BI10', 'receipt contact allowlist', [edit(checkout, "const contact = await deps.pool.query<{ email: string }>('SELECT email FROM order_contact WHERE order_id = $1'", "const contact = await deps.pool.query<{ email: string }>('SELECT email, full_name, phone FROM order_contact WHERE order_id = $1'"),
    edit(checkout, 'receiptContact: { email }', 'receiptContact: contact.rows[0]!')]],
  ['BI11', 'immutable order contract trigger', [edit('migrations/0008_editorial_offers_and_contract_snapshot.sql',
    'CREATE TRIGGER trg_order_contract_immutable BEFORE UPDATE OF contract_snapshot, contract_snapshot_sha256, departure_id ON orders\n  FOR EACH ROW EXECUTE FUNCTION fn_order_contract_immutable();', '-- immutable contract trigger removed')]],
  ['BI12', 'paid amount equality', [edit(checkout, 'if (p.amountKopecks !== payableKopecks)', 'if (false)')]],
  ['BI13', 'ambiguous mail quarantine', [edit('src/email.ts', "await attention(result.code, 'outcome_unknown');", "await pool.query(`UPDATE email_outbox SET state = 'PENDING', lease_until = NULL WHERE id = $1`, [row.id]);")]],
  ['BI14', 'expired send lease quarantine', [edit('src/email.ts', "if (row.state === 'SENDING')", 'if (false)')]],
  ['BI15', 'EIS replay refusal', [edit('migrations/0006_eis_filing.sql', "IF v_old_status NOT IN ('EIS_PENDING','EIS_NEEDS_UPDATE') THEN", 'IF false THEN')]],
  ['BI16', 'EIS reviewed revision fence', [edit('migrations/0006_eis_filing.sql', 'IF p_expected_revision IS NULL OR p_expected_revision <> v_revision THEN', 'IF false THEN')]],
  ['BI17', 'frozen offer integrity', [edit(checkout, "if (o.legal_release_content === null || o.legal_release_hash !== `sha256:${sha256(o.legal_release_content)}`\n        || o.legal_release_ref.trim() === '')", 'if (false)')]],
  ['BI18', 'frozen consent integrity', [edit(checkout, "if (o.pd_consent_hash !== `sha256:${sha256(o.pd_consent_content)}` || o.pd_consent_ref.trim() === '')", 'if (false)')]],
  ['BI19', 'payment snapshot binding', [edit(checkout, 'if (attempt.snapshotHash !== snapshotHash)', 'if (false)')]],
  ['BI20', 'immutable accepted document trigger', [edit('migrations/0003_tourists_and_contract.sql',
    'CREATE TRIGGER trg_order_document_frozen BEFORE UPDATE ON order_document\n  FOR EACH ROW EXECUTE FUNCTION fn_order_document_frozen();', '-- frozen document trigger removed')]],
  ['BI21', 'refund qualification gate', [edit(checkout, 'if (!refundWorkflowQualified(deps.catalog))', 'if (false)')]],
  ['BI22', 'fulfilment ACK attempt identity', [edit(checkout, 'body.checkoutAttemptId === attemptId', 'true')]],
  ['BI23', 'fulfilment ACK delivered status', [edit(checkout, "body.status === 'DELIVERED'", 'true')]],
  ['BI24', 'fulfilment ACK body validation', [edit(checkout,
    "return body !== null && typeof body === 'object' && !Array.isArray(body)\n    && 'checkoutAttemptId' in body && body.checkoutAttemptId === attemptId\n    && 'status' in body && body.status === 'DELIVERED';", 'return true;')]],
  ['BI25', 'saved ACK response replay', [edit('test/fake-refref.ts', 'const record = existing ?? { request: fingerprint, responseBody: JSON.stringify(',
    'const record = { request: fingerprint, responseBody: JSON.stringify(')]],
  ['BI26', 'one-shot transit corruption', [edit('test/fake-refref.ts', '              this.ackTransitBody = undefined;', '              // transit fault is incorrectly retained')]],
];

const scratch = mkdtempSync(join(tmpdir(), 'mikluha-art327-'));
function run(pattern) {
  const args = ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1'];
  if (pattern) args.push(`--test-name-pattern=^${pattern} `);
  args.push('test/business-invariants.test.ts');
  const result = spawnSync(process.execPath, args, { cwd: scratch, env: process.env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  // Timeouts, signals, broken runner/setup and compiler errors must never qualify as a kill.
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'Test process must exit normally');
  return { status: result.status, output: result.stdout + result.stderr };
}
function green(result, label, count) {
  assert.equal(result.status, 0, `${label}: expected green\n${result.output}`);
  assert.match(result.output, new RegExp(`# pass ${count}\\b`), `${label}: required tests did not execute`);
  assert.match(result.output, /# fail 0\b/);
  assert.match(result.output, /# cancelled 0\b/);
}
try {
  for (const entry of ['src', 'test', 'migrations', 'package.json']) cpSync(join(root, entry), join(scratch, entry), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  green(run(), 'baseline', 26);
  console.log('baseline: 26 business invariants PASS');
  for (const [id, label, edits] of mutants) {
    const originals = new Map();
    try {
      for (const { file, from, to } of edits) {
        const path = join(scratch, file);
        const source = readFileSync(path, 'utf8');
        if (!originals.has(path)) originals.set(path, source);
        assert.equal(source.split(from).length - 1, 1, `${id} ${label}: mutation anchor drift in ${file}`);
        writeFileSync(path, source.replace(from, to));
      }
      // SQL mutants must reach the selected BUSINESS assertion, rather than failing setup
      // at ART-317 integrity validation. Rehash only this disposable copy; Git history and
      // committed lock remain unchanged and their own sabotage tests still reject rehashes.
      const sqlEdits = edits.filter(({ file }) => file.startsWith('migrations/') && file.endsWith('.sql'));
      if (sqlEdits.length > 0) {
        const lockPath = join(scratch, 'migrations/migration.lock');
        const source = readFileSync(lockPath, 'utf8');
        originals.set(lockPath, source);
        const lock = JSON.parse(source);
        for (const { file } of sqlEdits) {
          const entry = lock.migrations.find(m => m.file === file.slice('migrations/'.length));
          assert.ok(entry, `Missing locked SQL mutant ${file}`);
          entry.checksum = createHash('sha256').update(readFileSync(join(scratch, file))).digest('hex');
        }
        writeFileSync(lockPath, JSON.stringify(lock));
      }
      const result = run(id);
      assert.equal(result.status, 1, `${id} ${label}: mutation survived\n${result.output}`);
      assert.match(result.output, new RegExp(`not ok \\d+ - ${id} `), `Missing selected invariant failure\n${result.output}`);
      assert.match(result.output, new RegExp(`error: (?:['\"]${id}:|\\|-\\n +${id}:)`), `Wrong failure witness\n${result.output}`);
      assert.match(result.output, /code: 'ERR_ASSERTION'/, `Not an assertion failure\n${result.output}`);
      assert.match(result.output, /# fail 1\b/);
      assert.match(result.output, /# cancelled 0\b/);
    } finally {
      for (const [path, source] of originals) writeFileSync(path, source);
    }
    green(run(id), `${id} restored`, 1);
    console.log(`${id} ${label}: KILLED by business assertion; restored PASS`);
  }
  console.log(`ART327_SABOTAGE_PASS: ${mutants.length}/${mutants.length} mutations killed and restored; no live qualification`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
