import type pg from 'pg';

export const DEFAULT_PAID_GRACE_SECONDS = 300;

export interface MonitorBucket {
  readonly count: number;
  readonly oldestSeconds: number | null;
}

export interface CommerceMonitorSignals {
  readonly observedAt: string;
  readonly paidNotFulfilled: MonitorBucket;
  readonly held: MonitorBucket;
}

interface AggregateRow {
  readonly count: string;
  readonly oldest_seconds: string | null;
}

const bucket = (row: AggregateRow): MonitorBucket => ({
  count: Number(row.count),
  oldestSeconds: row.oldest_seconds === null ? null : Math.max(0, Math.floor(Number(row.oldest_seconds))),
});

/**
 * Privacy-safe launch signals. Deliberately return aggregates only: order refs, hold reasons and
 * customer data must never enter the host monitor or its notification transport.
 */
export async function commerceMonitorSignals(
  pool: pg.Pool,
  now = new Date(),
  paidGraceSeconds = DEFAULT_PAID_GRACE_SECONDS,
): Promise<CommerceMonitorSignals> {
  if (!Number.isSafeInteger(paidGraceSeconds) || paidGraceSeconds < 0 || paidGraceSeconds > 86_400) {
    throw new Error('MONITOR_PAID_GRACE_INVALID');
  }

  const [paid, held] = await Promise.all([
    pool.query<AggregateRow>(`SELECT count(*)::text AS count,
        extract(epoch FROM ($1::timestamptz - min(paid_at)))::text AS oldest_seconds
      FROM orders
      WHERE status = 'PAID' AND paid_at <= $1::timestamptz - ($2::int * interval '1 second')`,
    [now, paidGraceSeconds]),
    pool.query<AggregateRow>(`SELECT count(*)::text AS count,
        extract(epoch FROM ($1::timestamptz - min(payment_pending_since)))::text AS oldest_seconds
      FROM orders
      WHERE status = 'HELD'`, [now]),
  ]);

  return {
    observedAt: now.toISOString(),
    paidNotFulfilled: bucket(paid.rows[0]!),
    held: bucket(held.rows[0]!),
  };
}

export function monitorHasAlert(signals: CommerceMonitorSignals): boolean {
  return signals.paidNotFulfilled.count > 0 || signals.held.count > 0;
}
