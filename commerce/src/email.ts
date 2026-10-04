// ART-47 owner decision: transactional confirmation mail uses UniSender Go, replacing the older
// reg.ru SMTP plan. The reconciliation request only writes email_outbox; this worker sends later.

import type pg from 'pg';

import type { Logger } from './log.js';

export interface EmailConfig {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly fromName: string;
  readonly replyTo?: string;
  readonly commerceOrigin: string;
  readonly apiBase?: string;
  readonly timeoutMs?: number;
}

export type SendResult =
  | { readonly kind: 'ACCEPTED'; readonly jobId: string }
  | { readonly kind: 'AMBIGUOUS'; readonly code: string }
  | { readonly kind: 'DUPLICATE'; readonly code: 'IDEMPOTENCE_DUPLICATE' }
  | { readonly kind: 'REJECTED'; readonly code: string };

export interface EmailSender {
  send(input: { recipient: string; orderRef: string; accessToken: string; idempotencyKey: string }): Promise<SendResult>;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const safeCode = (value: unknown, fallback: string): string => {
  const code = typeof value === 'string' || typeof value === 'number'
    ? String(value).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60) : '';
  return code || fallback;
};

export class UniSenderGoClient implements EmailSender {
  readonly #config: EmailConfig;
  readonly #fetch: Fetcher;

  constructor(config: EmailConfig, fetcher: Fetcher = fetch) {
    this.#config = config;
    this.#fetch = fetcher;
  }

  async send(input: { recipient: string; orderRef: string; accessToken: string; idempotencyKey: string }): Promise<SendResult> {
    const url = `${this.#config.commerceOrigin.replace(/\/$/, '')}/documents/${input.accessToken}`;
    const text = `Бронирование подтверждено\n\nНомер заказа: ${input.orderRef}\n\n` +
      `Откройте защищённую ссылку ${url}, чтобы увидеть сохранённые договорные документы. Не пересылайте её другим людям.\n\n` +
      'Билеты и ваучеры будут отправлены отдельно не позднее чем за 24 часа до начала поездки.';
    const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#faf7f0;color:#3b3029;font-family:Arial,sans-serif">` +
      `<div style="max-width:600px;margin:0 auto;padding:32px 20px"><div style="border-radius:20px;background:#fff;border:1px solid #e3d8cb;padding:32px">` +
      `<p style="margin:0 0 8px;color:#23617a;font-size:13px;letter-spacing:.08em;text-transform:uppercase">Миклуха</p>` +
      `<h1 style="margin:0 0 16px;font-size:28px;line-height:1.15">Бронирование подтверждено</h1>` +
      `<p>Номер заказа: <strong>${input.orderRef}</strong></p>` +
      `<p>По защищённой ссылке доступны сохранённые редакции Оферты и Заявки. Не пересылайте её другим людям.</p>` +
      `<p style="margin:24px 0"><a href="${url}" style="display:inline-block;border-radius:999px;background:#c8693e;color:#fff;text-decoration:none;padding:13px 20px;font-weight:700">Открыть заказ и документы</a></p>` +
      `<p style="color:#6f6258;font-size:14px">Билеты и ваучеры будут отправлены отдельно не позднее чем за 24 часа до начала поездки.</p>` +
      `</div></div></body></html>`;
    const message: Record<string, unknown> = {
      recipients: [{ email: input.recipient, metadata: { order_ref: input.orderRef } }],
      from_email: this.#config.fromEmail, from_name: this.#config.fromName,
      subject: `Бронирование ${input.orderRef} подтверждено`, body: { html, plaintext: text },
      idempotence_key: input.idempotencyKey,
    };
    if (this.#config.replyTo !== undefined) message.reply_to = this.#config.replyTo;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 15_000);
    try {
      const response = await this.#fetch(this.#config.apiBase ??
        'https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json', {
        method: 'POST', signal: controller.signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': this.#config.apiKey },
        body: JSON.stringify({ message }),
      });
      let body: unknown;
      try { body = await response.json(); } catch { body = null; }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return { kind: 'AMBIGUOUS', code: `HTTP_${response.status}` };
      }
      const parsed = body as { status?: unknown; job_id?: unknown; failed_emails?: unknown; code?: unknown;
        error?: { code?: unknown } } | null;
      const providerCode = parsed?.code ?? parsed?.error?.code;
      if (String(providerCode) === '1573') return { kind: 'DUPLICATE', code: 'IDEMPOTENCE_DUPLICATE' };
      const failures = parsed?.failed_emails;
      const hasFailures = Array.isArray(failures) ? failures.length > 0
        : typeof failures === 'object' && failures !== null ? Object.keys(failures).length > 0 : failures !== undefined;
      if (response.status >= 200 && response.status < 300 && parsed?.status === 'success'
        && typeof parsed.job_id === 'string' && parsed.job_id !== '' && !hasFailures) {
        return { kind: 'ACCEPTED', jobId: parsed.job_id };
      }
      if (response.status >= 400 && response.status < 500) {
        return { kind: 'REJECTED', code: safeCode(providerCode, `HTTP_${response.status}`) };
      }
      if (response.status >= 200 && response.status < 300 && hasFailures) {
        return { kind: 'REJECTED', code: 'RECIPIENT_REJECTED' };
      }
      return { kind: 'AMBIGUOUS', code: 'UNREADABLE_RESPONSE' };
    } catch (e) {
      return { kind: 'AMBIGUOUS', code: e instanceof Error && e.name === 'AbortError' ? 'TIMEOUT' : 'TRANSPORT' };
    } finally { clearTimeout(timer); }
  }
}

interface OutboxRow {
  id: string; order_ref: string; recipient_email: string; access_token: string; idempotency_key: string; attempts: number;
  first_attempt_at: Date | null;
}

type SendableOutboxRow = Omit<OutboxRow, 'first_attempt_at'> & { readonly first_attempt_at: Date };
type Claim = { readonly kind: 'SEND'; readonly row: SendableOutboxRow }
  | { readonly kind: 'WINDOW_EXPIRED'; readonly row: Pick<OutboxRow, 'id' | 'order_ref' | 'attempts'> };

// UniSender only rejects a repeated idempotence key for one minute. A retry may start for the
// first 40 seconds, leaving a 20-second margin (greater than the 15-second request timeout).
const SAFE_RETRY_START_WINDOW_MS = 40_000;
const AMBIGUOUS_RETRY_DELAY_MS = 10_000;

async function claim(pool: pg.Pool, now: Date): Promise<Claim | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(`SELECT e.id, o.order_ref, e.recipient_email, e.access_token,
      e.idempotency_key, e.attempts, e.first_attempt_at
      FROM email_outbox e JOIN orders o ON o.id = e.order_id
      WHERE e.recipient_email IS NOT NULL AND e.next_attempt_at <= $1
        AND (e.state = 'PENDING' OR (e.state = 'SENDING' AND e.lease_until <= $1))
      ORDER BY e.next_attempt_at, e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1`, [now]);
    const row = rows[0];
    if (row === undefined) { await client.query('COMMIT'); return null; }
    if (row.first_attempt_at !== null
      && now.getTime() >= row.first_attempt_at.getTime() + SAFE_RETRY_START_WINDOW_MS) {
      await client.query(`UPDATE email_outbox SET state = 'ATTENTION', lease_until = NULL,
        last_error_code = 'DEDUPE_WINDOW_EXPIRED' WHERE id = $1`, [row.id]);
      await client.query('COMMIT');
      return { kind: 'WINDOW_EXPIRED', row };
    }
    const firstAttemptAt = row.first_attempt_at ?? now;
    await client.query(`UPDATE email_outbox SET state = 'SENDING', attempts = attempts + 1,
      first_attempt_at = COALESCE(first_attempt_at, $2), lease_until = $3, last_error_code = NULL
      WHERE id = $1`, [row.id, firstAttemptAt, new Date(now.getTime() + 2 * 60_000)]);
    await client.query('COMMIT');
    return { kind: 'SEND', row: { ...row, attempts: row.attempts + 1, first_attempt_at: firstAttemptAt } };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}

/** Process at most `limit` due messages. Nothing personal is included in logs. */
export async function processEmailOutbox(pool: pg.Pool, sender: EmailSender, log: Logger,
  clock: () => Date = () => new Date(), limit = 10): Promise<number> {
  let processed = 0;
  while (processed < limit) {
    const claimed = await claim(pool, clock());
    if (claimed === null) break;
    if (claimed.kind === 'WINDOW_EXPIRED') {
      log('confirmation_email_attention', { orderRef: claimed.row.order_ref, outboxId: claimed.row.id,
        code: 'DEDUPE_WINDOW_EXPIRED', attempts: claimed.row.attempts });
      processed += 1;
      continue;
    }
    const row = claimed.row;
    const result = await sender.send({ recipient: row.recipient_email, orderRef: row.order_ref,
      accessToken: row.access_token, idempotencyKey: row.idempotency_key });
    const finishedAt = clock();
    if (result.kind === 'ACCEPTED') {
      await pool.query(`UPDATE email_outbox SET state = 'ACCEPTED', provider_job_id = $2, sent_at = $3,
        access_token = NULL, lease_until = NULL, last_error_code = NULL WHERE id = $1 AND state = 'SENDING'`,
      [row.id, result.jobId, finishedAt]);
      log('confirmation_email_accepted', { orderRef: row.order_ref, outboxId: row.id, attempts: row.attempts });
    } else if (result.kind === 'REJECTED' || result.kind === 'DUPLICATE') {
      await pool.query(`UPDATE email_outbox SET state = 'ATTENTION', lease_until = NULL, last_error_code = $2
        WHERE id = $1 AND state = 'SENDING'`, [row.id, result.code]);
      log('confirmation_email_attention', { orderRef: row.order_ref, outboxId: row.id, code: result.code, attempts: row.attempts });
    } else {
      const nextAttemptAt = new Date(finishedAt.getTime() + AMBIGUOUS_RETRY_DELAY_MS);
      const retryDeadline = row.first_attempt_at.getTime() + SAFE_RETRY_START_WINDOW_MS;
      if (nextAttemptAt.getTime() >= retryDeadline) {
        await pool.query(`UPDATE email_outbox SET state = 'ATTENTION', lease_until = NULL, last_error_code = $2
          WHERE id = $1 AND state = 'SENDING'`, [row.id, result.code]);
        log('confirmation_email_attention', { orderRef: row.order_ref, outboxId: row.id,
          code: result.code, reason: 'dedupe_window_closed', attempts: row.attempts });
      } else {
        await pool.query(`UPDATE email_outbox SET state = 'PENDING', next_attempt_at = $2, lease_until = NULL,
          last_error_code = $3 WHERE id = $1 AND state = 'SENDING'`,
        [row.id, nextAttemptAt, result.code]);
        log('confirmation_email_retry', { orderRef: row.order_ref, outboxId: row.id,
          code: result.code, attempts: row.attempts });
      }
    }
    processed += 1;
  }
  return processed;
}
