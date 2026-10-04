// Refref's Merchant API, as an external merchant uses it: base URL, bearer key, the published paths
// (refref docs/openapi.yaml, docs/28). Every call ends in one of two shapes:
//   ANSWERED  Refref answered with an HTTP status (2xx success, 4xx a definitive refusal)
//   UNKNOWN   no answer, a timeout, or a 5xx/429: the request may or may not have taken effect.
//             The caller repeats the SAME request (same body, same Idempotency-Key) later; it never
//             assumes it failed and never makes a different one in its place.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type RefrefResult<T = unknown> =
  | { readonly kind: 'ANSWERED'; readonly status: number; readonly body: T }
  | { readonly kind: 'UNKNOWN'; readonly cause: string };

export interface RefrefConfig {
  /** e.g. https://api.refref.ru/v1-rc */
  readonly apiBase: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
}

export interface ResolutionLineBody {
  lineRef: string; offerRef: string; unitRef: string; quantity: number; merchantOfferAmountKopecks: number;
  serviceStartsAt: string; serviceEndsAt: string;
}

export interface ResolvedResolution {
  status: 'RESOLVED'; referralResolutionId: string; merchantOrderRef: string; attributionSource: string;
  termsVersionId: string | null; inputHash: string; lines: { lineRef: string; referralDiscountAmountKopecks: number }[];
  expiresAt: string;
}
export interface CustomerActionRequired { status: 'CUSTOMER_ACTION_REQUIRED'; customerActionUrl: string }
export interface PaymentSession {
  status: 'PAYMENT_READY' | 'PAYMENT_PROCESSING' | 'PAYMENT_FAILED';
  providerPaymentUrl?: string; failureCode?: string; supportReference: string;
}
export interface CheckoutAttempt {
  id: string; status: 'OPEN' | 'SETTLED' | 'CANCELLED' | 'EXPIRED'; snapshotHash: string;
  obligations: {
    obligationRef: string; status: 'OUTSTANDING' | 'IN_PROGRESS' | 'SATISFIED' | 'LATE_PAYMENT' | 'CANCELLED';
    amountKopecks: number;
    payment: null | { id: string; status: string; amountKopecks: number; succeededAt?: string | null };
  }[];
}
/** Refref's Error: `{ error: { code, … } }`. */
export interface RefrefError { error?: { code?: string } }

export const errorCode = (body: unknown): string => {
  const b = body as RefrefError | null;
  const code = b?.error?.code;
  return typeof code === 'string' && /^[A-Z_]{1,60}$/.test(code) ? code : 'UNRECOGNIZED';
};

export class RefrefClient {
  readonly #base: URL;
  readonly #key: string;
  readonly #timeout: number;

  constructor(config: RefrefConfig) {
    this.#base = new URL(config.apiBase);
    this.#key = config.apiKey;
    this.#timeout = config.timeoutMs ?? 15_000;
  }

  /** The handoff token is the idempotency identity: no Idempotency-Key (docs/28 §5). */
  resolve(body: { handoffToken: string; merchantOrderRef: string; currency: 'RUB'; lines: ResolutionLineBody[] }) {
    return this.#send<ResolvedResolution | CustomerActionRequired>('POST', '/integrations/referral-resolutions', body);
  }

  createAttempt(orderRef: string, body: { referralResolutionId: string; snapshot: unknown; snapshotHash: string }, key: string) {
    return this.#send<{ checkoutAttemptId: string; snapshotHash: string }>('POST',
      `/integrations/orders/${encodeURIComponent(orderRef)}/checkout-attempts`, body, key);
  }

  getAttempt(orderRef: string, attemptId: string) {
    return this.#send<CheckoutAttempt>('GET',
      `/integrations/orders/${encodeURIComponent(orderRef)}/checkout-attempts/${encodeURIComponent(attemptId)}`);
  }

  /** No Idempotency-Key: a live initiation is replayed, never submitted twice (docs/28 §11). */
  paymentSession(orderRef: string, attemptId: string, obligationRef: string, body: { successUrl: string; receiptContact: { email: string } }) {
    return this.#send<PaymentSession>('POST', `/integrations/orders/${encodeURIComponent(orderRef)}/checkout-attempts/`
      + `${encodeURIComponent(attemptId)}/obligations/${encodeURIComponent(obligationRef)}/payment-session`, body);
  }

  cancelAttempt(orderRef: string, attemptId: string, key: string) {
    return this.#send<CheckoutAttempt>('POST', `/integrations/orders/${encodeURIComponent(orderRef)}/checkout-attempts/`
      + `${encodeURIComponent(attemptId)}/cancel`, {}, key);
  }

  acknowledgeFulfillment(orderRef: string, attemptId: string, key: string) {
    return this.#send<{ status: string }>('POST', `/integrations/orders/${encodeURIComponent(orderRef)}/checkout-attempts/`
      + `${encodeURIComponent(attemptId)}/fulfillment-ack`, { status: 'DELIVERED', externalFulfillmentId: orderRef }, key);
  }

  #send<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<RefrefResult<T>> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = { authorization: `Bearer ${this.#key}`, accept: 'application/json' };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.byteLength);
    }
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    const secure = this.#base.protocol === 'https:';
    return new Promise((resolve) => {
      const req = (secure ? httpsRequest : httpRequest)({
        host: this.#base.hostname, port: this.#base.port === '' ? undefined : Number(this.#base.port),
        method, path: `${this.#base.pathname.replace(/\/$/, '')}${path}`, headers, timeout: this.#timeout,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', () => resolve({ kind: 'UNKNOWN', cause: 'RESPONSE_ERROR' }));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 500 || status === 429 || status === 0) { resolve({ kind: 'UNKNOWN', cause: `HTTP_${status}` }); return; }
          let parsed: unknown = null;
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            parsed = text === '' ? null : JSON.parse(text);
          } catch {
            // A 2xx we cannot read is not an answer we can act on.
            if (status < 300) { resolve({ kind: 'UNKNOWN', cause: 'UNREADABLE_RESPONSE' }); return; }
          }
          resolve({ kind: 'ANSWERED', status, body: parsed as T });
        });
      });
      req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
      req.on('error', (e) => resolve({ kind: 'UNKNOWN', cause: e.message === 'TIMEOUT' ? 'TIMEOUT' : 'TRANSPORT' }));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
