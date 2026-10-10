// ART-47 owner decision (2026-10-08): transactional confirmation mail uses Notisend
// (https://notisend.ru/). The reconciliation request only writes email_outbox; this worker sends later.

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

// Notisend's send API has no idempotency key, so the client must say whether a failed send could
// have been queued. NOT_SENT is proof that it was not (a later send cannot duplicate it); AMBIGUOUS
// is any outcome where it may have been.
export type SendResult =
  | { readonly kind: 'ACCEPTED'; readonly jobId: string }
  | { readonly kind: 'NOT_SENT'; readonly code: string; readonly retryAfterMs: number }
  | { readonly kind: 'AMBIGUOUS'; readonly code: string }
  | { readonly kind: 'REJECTED'; readonly code: string };

export interface EmailSender {
  send(input: { recipient: string; orderRef: string; accessToken: string; outboxKey: string }): Promise<SendResult>;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const NOTISEND_MESSAGES_URL = 'https://api.notisend.ru/v1/email/messages';
const MAX_RESPONSE_BYTES = 16_384;

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch { return null; }
  finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
// The stable outbox key travels as a header, so an operator can match an ambiguous send to the
// message in the Notisend log. It is not an idempotency key: Notisend does not deduplicate on it.
export const OUTBOX_KEY_HEADER = 'X-Mikluha-Outbox-Key';
const QUEUED_STATUSES = new Set(['queued', 'sent', 'delivered']);
const NOT_SENT_STATUSES = new Set(['skipped', 'soft_bounced', 'hard_bounced']);
// Errors raised before a connection exists: the request never left this process.
const PRE_CONNECT_ERRORS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT']);
const RATE_LIMIT_DEFAULT_MS = 60_000;
const RATE_LIMIT_MIN_MS = 10_000;
const RATE_LIMIT_MAX_MS = 15 * 60_000;
const CONNECT_RETRY_MS = 30_000;

// Notisend answers a throttled send with 429 and `Too many messages. Try again in 92 seconds.`
const rateLimitDelay = (body: unknown): number => {
  const errors = (body as { errors?: unknown } | null)?.errors;
  const detail = Array.isArray(errors) ? (errors[0] as { detail?: unknown } | undefined)?.detail : undefined;
  const seconds = typeof detail === 'string' ? /try again in (\d+) seconds?/i.exec(detail)?.[1] : undefined;
  const ms = seconds === undefined ? RATE_LIMIT_DEFAULT_MS : Number(seconds) * 1000;
  return Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, ms));
};

const preConnectError = (e: unknown): string | undefined => {
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && PRE_CONNECT_ERRORS.has(code) ? code : undefined;
};

export class NotisendClient implements EmailSender {
  readonly #config: EmailConfig;
  readonly #fetch: Fetcher;

  constructor(config: EmailConfig, fetcher: Fetcher = fetch) {
    this.#config = config;
    this.#fetch = fetcher;
  }

  async send(input: { recipient: string; orderRef: string; accessToken: string; outboxKey: string }): Promise<SendResult> {
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
    const smtpHeaders: Record<string, string> = { [OUTBOX_KEY_HEADER]: input.outboxKey };
    if (this.#config.replyTo !== undefined) smtpHeaders['Reply-To'] = this.#config.replyTo;
    const message = {
      from_email: this.#config.fromEmail, from_name: this.#config.fromName, to: input.recipient,
      subject: `Бронирование ${input.orderRef} подтверждено`, text, html, smtp_headers: smtpHeaders,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 15_000);
    try {
      const response = await this.#fetch(this.#config.apiBase ?? NOTISEND_MESSAGES_URL, {
        // A redirected request could fail to connect after the original POST was accepted.
        // Refuse redirects so a PRE_CONNECT error can only describe the first submission.
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', 'content-type': 'application/json',
          authorization: `Bearer ${this.#config.apiKey}` },
        body: JSON.stringify(message),
      });
      const body = await boundedJson(response);
      // A throttled send is refused before it is queued, so it is safe to send again later.
      if (response.status === 429) return { kind: 'NOT_SENT', code: 'HTTP_429', retryAfterMs: rateLimitDelay(body) };
      if (response.status === 408 || response.status >= 500) return { kind: 'AMBIGUOUS', code: `HTTP_${response.status}` };
      if (response.status >= 400) return { kind: 'REJECTED', code: `HTTP_${response.status}` };
      const parsed = body as { id?: unknown; status?: unknown } | null;
      const id = typeof parsed?.id === 'number' && Number.isSafeInteger(parsed.id) && parsed.id > 0 ? String(parsed.id)
        : typeof parsed?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(parsed.id) ? parsed.id : undefined;
      const status = typeof parsed?.status === 'string' ? parsed.status : undefined;
      if (response.status >= 200 && response.status < 300 && id !== undefined && status !== undefined) {
        if (QUEUED_STATUSES.has(status)) return { kind: 'ACCEPTED', jobId: id };
        if (NOT_SENT_STATUSES.has(status)) return { kind: 'REJECTED', code: `RECIPIENT_${status.toUpperCase()}` };
      }
      return { kind: 'AMBIGUOUS', code: 'UNREADABLE_RESPONSE' };
    } catch (e) {
      const preConnect = preConnectError(e);
      if (preConnect !== undefined) return { kind: 'NOT_SENT', code: preConnect, retryAfterMs: CONNECT_RETRY_MS };
      return { kind: 'AMBIGUOUS', code: e instanceof Error && e.name === 'AbortError' ? 'TIMEOUT' : 'TRANSPORT' };
    } finally { clearTimeout(timer); }
  }
}

interface OutboxRow {
  id: string; order_ref: string; recipient_email: string; access_token: string; idempotency_key: string; attempts: number;
}

type Claim = { readonly kind: 'SEND'; readonly row: OutboxRow }
  | { readonly kind: 'LEASE_EXPIRED'; readonly row: Pick<OutboxRow, 'id' | 'order_ref' | 'attempts'> };

// Notisend does not deduplicate, so only a send proven NOT_SENT is ever repeated automatically.
// Such retries stop after this many attempts and the row goes to operator attention.
const MAX_SEND_ATTEMPTS = 10;

async function claim(pool: pg.Pool, now: Date): Promise<Claim | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow & { state: string }>(`SELECT e.id, o.order_ref, e.recipient_email,
      e.access_token, e.idempotency_key, e.attempts, e.state
      FROM email_outbox e JOIN orders o ON o.id = e.order_id
      WHERE e.recipient_email IS NOT NULL AND e.next_attempt_at <= $1
        AND (e.state = 'PENDING' OR (e.state = 'SENDING' AND e.lease_until <= $1))
      ORDER BY e.next_attempt_at, e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1`, [now]);
    const row = rows[0];
    if (row === undefined) { await client.query('COMMIT'); return null; }
    // A worker stopped mid-send: Notisend may have queued the message, so it is never sent again.
    if (row.state === 'SENDING') {
      await client.query(`UPDATE email_outbox SET state = 'ATTENTION', lease_until = NULL,
        last_error_code = 'LEASE_EXPIRED' WHERE id = $1`, [row.id]);
      await client.query('COMMIT');
      return { kind: 'LEASE_EXPIRED', row };
    }
    await client.query(`UPDATE email_outbox SET state = 'SENDING', attempts = attempts + 1,
      first_attempt_at = COALESCE(first_attempt_at, $2), lease_until = $3, last_error_code = NULL
      WHERE id = $1`, [row.id, now, new Date(now.getTime() + 2 * 60_000)]);
    await client.query('COMMIT');
    return { kind: 'SEND', row: { ...row, attempts: row.attempts + 1 } };
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
    if (claimed.kind === 'LEASE_EXPIRED') {
      log('confirmation_email_attention', { orderRef: claimed.row.order_ref, outboxId: claimed.row.id,
        code: 'LEASE_EXPIRED', reason: 'outcome_unknown', attempts: claimed.row.attempts });
      processed += 1;
      continue;
    }
    const row = claimed.row;
    const result = await sender.send({ recipient: row.recipient_email, orderRef: row.order_ref,
      accessToken: row.access_token, outboxKey: row.idempotency_key });
    const finishedAt = clock();
    const attention = async (code: string, reason: string) => {
      await pool.query(`UPDATE email_outbox SET state = 'ATTENTION', lease_until = NULL, last_error_code = $2
        WHERE id = $1 AND state = 'SENDING'`, [row.id, code]);
      log('confirmation_email_attention', { orderRef: row.order_ref, outboxId: row.id, code, reason, attempts: row.attempts });
    };
    if (result.kind === 'ACCEPTED') {
      await pool.query(`UPDATE email_outbox SET state = 'ACCEPTED', provider_job_id = $2, sent_at = $3,
        access_token = NULL, lease_until = NULL, last_error_code = NULL WHERE id = $1 AND state = 'SENDING'`,
      [row.id, result.jobId, finishedAt]);
      log('confirmation_email_accepted', { orderRef: row.order_ref, outboxId: row.id, attempts: row.attempts });
    } else if (result.kind === 'REJECTED') {
      await attention(result.code, 'rejected');
    } else if (result.kind === 'AMBIGUOUS') {
      await attention(result.code, 'outcome_unknown');
    } else if (row.attempts >= MAX_SEND_ATTEMPTS) {
      await attention(result.code, 'retries_exhausted');
    } else {
      await pool.query(`UPDATE email_outbox SET state = 'PENDING', next_attempt_at = $2, lease_until = NULL,
        last_error_code = $3 WHERE id = $1 AND state = 'SENDING'`,
      [row.id, new Date(finishedAt.getTime() + result.retryAfterMs), result.code]);
      log('confirmation_email_retry', { orderRef: row.order_ref, outboxId: row.id,
        code: result.code, attempts: row.attempts });
    }
    processed += 1;
  }
  return processed;
}
