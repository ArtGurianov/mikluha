// Delivery of the per-order notices of an EQUIVALENT execution change (ADR v2.3 §4, migration 0009).
// The publish created exactly one execution_change_notice per affected order in its own transaction;
// this worker sends them later, as the confirmation outbox does (email.ts): Notisend has no
// idempotency key, so only a send proven NOT_SENT is repeated, and anything that may have been queued
// becomes operator attention, never a second mail. ACCEPTED is the provider's acceptance and nothing
// more; only a provider delivery report (recordNoticeDelivery) makes a notice DELIVERED.

import type pg from 'pg';

import type { SendResult } from './email.js';
import type { Logger } from './log.js';

export interface NoticeSender {
  sendExecutionNotice(input: { recipient: string; orderRef: string; notice: string; noticeKey: string }): Promise<SendResult>;
}

const MAX_SEND_ATTEMPTS = 10;
const LEASE_MS = 2 * 60_000;

interface NoticeRow {
  id: string; order_ref: string; recipient: string | null; notice: string; idempotency_key: string; attempts: number; state: string;
}

type Claim = { readonly kind: 'SEND'; readonly row: NoticeRow & { recipient: string } }
  | { readonly kind: 'ATTENTION'; readonly row: NoticeRow; readonly code: string };

async function claim(pool: pg.Pool, now: Date): Promise<Claim | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<NoticeRow>(`SELECT n.id, o.order_ref, c.email AS recipient, x.notice,
        n.idempotency_key, n.attempts, n.state
      FROM execution_change_notice n JOIN departure_execution_change x ON x.id = n.change_id
      JOIN orders o ON o.id = n.order_id LEFT JOIN order_contact c ON c.order_id = n.order_id
      WHERE n.next_attempt_at <= $1 AND (n.state = 'PENDING' OR (n.state = 'SENDING' AND n.lease_until <= $1))
      ORDER BY n.next_attempt_at, n.created_at FOR UPDATE OF n SKIP LOCKED LIMIT 1`, [now]);
    const row = rows[0];
    if (row === undefined) { await client.query('COMMIT'); return null; }
    // A worker stopped mid-send: Notisend may have queued it. An erased contact has nobody to tell.
    const code = row.state === 'SENDING' ? 'LEASE_EXPIRED' : row.recipient === null ? 'NO_RECIPIENT' : undefined;
    if (code !== undefined) {
      await client.query(`UPDATE execution_change_notice SET state = 'ATTENTION', lease_until = NULL, last_error_code = $2
        WHERE id = $1`, [row.id, code]);
      await client.query('COMMIT');
      return { kind: 'ATTENTION', row, code };
    }
    await client.query(`UPDATE execution_change_notice SET state = 'SENDING', attempts = attempts + 1,
      first_attempt_at = coalesce(first_attempt_at, $2), lease_until = $3, last_error_code = NULL WHERE id = $1`,
    [row.id, now, new Date(now.getTime() + LEASE_MS)]);
    await client.query('COMMIT');
    return { kind: 'SEND', row: { ...row, recipient: row.recipient!, attempts: row.attempts + 1 } };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}

/** Process at most `limit` due notices. Logs carry order references and codes only. */
export async function processExecutionNotices(pool: pg.Pool, sender: NoticeSender, log: Logger,
  clock: () => Date = () => new Date(), limit = 10): Promise<number> {
  let processed = 0;
  while (processed < limit) {
    const claimed = await claim(pool, clock());
    if (claimed === null) break;
    processed += 1;
    if (claimed.kind === 'ATTENTION') {
      log('execution_notice_attention', { orderRef: claimed.row.order_ref, noticeId: claimed.row.id,
        code: claimed.code, attempts: claimed.row.attempts });
      continue;
    }
    const row = claimed.row;
    const result = await sender.sendExecutionNotice({ recipient: row.recipient, orderRef: row.order_ref,
      notice: row.notice, noticeKey: row.idempotency_key });
    const finishedAt = clock();
    const attention = async (code: string, reason: string) => {
      await pool.query(`UPDATE execution_change_notice SET state = 'ATTENTION', lease_until = NULL, last_error_code = $2
        WHERE id = $1 AND state = 'SENDING'`, [row.id, code]);
      log('execution_notice_attention', { orderRef: row.order_ref, noticeId: row.id, code, reason, attempts: row.attempts });
    };
    if (result.kind === 'ACCEPTED') {
      await pool.query(`UPDATE execution_change_notice SET state = 'ACCEPTED', provider_job_id = $2, accepted_at = $3,
        lease_until = NULL, last_error_code = NULL WHERE id = $1 AND state = 'SENDING'`, [row.id, result.jobId, finishedAt]);
      log('execution_notice_accepted', { orderRef: row.order_ref, noticeId: row.id, attempts: row.attempts });
    } else if (result.kind === 'REJECTED') {
      await attention(result.code, 'rejected');
    } else if (result.kind === 'AMBIGUOUS') {
      await attention(result.code, 'outcome_unknown');
    } else if (row.attempts >= MAX_SEND_ATTEMPTS) {
      await attention(result.code, 'retries_exhausted');
    } else {
      await pool.query(`UPDATE execution_change_notice SET state = 'PENDING', next_attempt_at = $2, lease_until = NULL,
        last_error_code = $3 WHERE id = $1 AND state = 'SENDING'`,
      [row.id, new Date(finishedAt.getTime() + result.retryAfterMs), result.code]);
      log('execution_notice_retry', { orderRef: row.order_ref, noticeId: row.id, code: result.code, attempts: row.attempts });
    }
  }
  return processed;
}

/**
 * A provider delivery report for an accepted notice: `delivered` makes it DELIVERED, a bounce makes it
 * operator attention. Returns false when the notice was not waiting for one.
 * Storage primitive only: no runtime provider-report consumer is wired yet (ART-365). That
 * integration must verify the status source and correlate provider_job_id before calling this.
 */
export async function recordNoticeDelivery(pool: pg.Pool, noticeId: string, providerStatus: 'delivered' | 'soft_bounced' | 'hard_bounced',
  at: Date = new Date()): Promise<boolean> {
  const { rowCount } = providerStatus === 'delivered'
    ? await pool.query(`UPDATE execution_change_notice SET state = 'DELIVERED', provider_status = $2, delivered_at = $3
        WHERE id = $1 AND state = 'ACCEPTED'`, [noticeId, providerStatus, at])
    : await pool.query(`UPDATE execution_change_notice SET state = 'ATTENTION', provider_status = $2, last_error_code = $3
        WHERE id = $1 AND state = 'ACCEPTED'`, [noticeId, providerStatus, `RECIPIENT_${providerStatus.toUpperCase()}`]);
  return rowCount === 1;
}
