// A model of Refref's Merchant API (refref docs/28, docs/openapi.yaml) for the flow tests: the
// answers a real Refref gives, plus the failures the flow must survive. It records every request,
// so a test can prove what was (and was not) sent.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { resolutionInputHash, snapshotDigest, type Json, type ResolutionLine } from '../src/snapshot.js';

export interface Recorded { method: string; path: string; key: string | undefined; body: unknown }

type Behaviour = 'OK' | 'TIMEOUT' | 'ACCEPTED_TIMEOUT' | 'ERROR_500' | { status: number; code: string };

export interface FakeState {
  discountKopecks: number;
  attempt: Behaviour;
  session: Behaviour | 'READY' | 'PROCESSING' | 'FAILED';
  cancel: Behaviour | 'OK';
  /** What the attempt reads back as. */
  obligation: 'OUTSTANDING' | 'IN_PROGRESS' | 'SATISFIED' | 'LATE_PAYMENT';
  attemptStatus: 'OPEN' | 'SETTLED' | 'CANCELLED' | 'EXPIRED';
  paymentAmountDelta: number;
  projectionMismatch: boolean;
  projectionResolutionMismatch: boolean;
}

export class FakeRefref {
  readonly requests: Recorded[] = [];
  readonly attempts = new Map<string, { id: string; key: string; body: string; snapshotHash: string;
    referralResolutionId: string; payable: number }>();
  state: FakeState = { discountKopecks: 0, attempt: 'OK', session: 'READY', cancel: 'OK', obligation: 'IN_PROGRESS',
    attemptStatus: 'OPEN', paymentAmountDelta: 0, projectionMismatch: false, projectionResolutionMismatch: false };
  #server: Server | null = null;
  #gate: { arrived: () => void; released: Promise<void> } | null = null;

  /**
   * Hold the next payment-session request inside Refref: `arrived` resolves when it reaches here,
   * and it is answered only after `release()`.
   */
  holdSessions(): { arrived: Promise<void>; release: () => void } {
    let arrived!: () => void;
    let release!: () => void;
    const a = new Promise<void>((r) => { arrived = r; });
    this.#gate = { arrived, released: new Promise<void>((r) => { release = r; }) };
    return { arrived: a, release };
  }
  base = '';

  constructor(readonly merchantId: string) {}

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text === '' ? null : JSON.parse(text);
        const path = (req.url ?? '').replace(/^\/v1-rc/, '');
        const key = req.headers['idempotency-key'] as string | undefined;
        this.requests.push({ method: req.method ?? '', path, key, body });
        const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        const behave = (b: Behaviour, ok: () => void) => {
          if (b === 'TIMEOUT') return; // never answers; the client times out
          if (b === 'ERROR_500') { send(500, { error: { code: 'INTERNAL' } }); return; }
          if (typeof b === 'object') { send(b.status, { error: { code: b.code } }); return; }
          ok();
        };
        let m: RegExpExecArray | null;
        if (req.method === 'POST' && path === '/integrations/referral-resolutions') {
          const line = body.lines[0];
          send(201, { status: 'RESOLVED', referralResolutionId: '7a0e1c3b-5d2f-4e8a-b6c1-9f3d2e4a5b60', merchantOrderRef: body.merchantOrderRef,
            attributionSource: this.state.discountKopecks > 0 ? 'GRANT' : 'UNATTRIBUTED', campaignId: null, termsVersionId: null,
            checkoutCodeOutcome: 'NONE', inputHash: this.inputHash(body.merchantOrderRef, body.lines), currency: 'RUB',
            lines: [{ lineRef: line.lineRef, eligible: this.state.discountKopecks > 0, referralDiscountAmountKopecks: this.state.discountKopecks }],
            totals: {}, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
        } else if (req.method === 'POST' && (m = /^\/integrations\/orders\/([^/]+)\/checkout-attempts$/.exec(path))) {
          const accept = (answer: boolean) => {
            const ref = m![1]!;
            const existing = this.attempts.get(ref);
            if (existing && (existing.key !== key || existing.body !== text)) { send(409, { error: { code: 'IDEMPOTENCY_KEY_CONFLICT' } }); return; }
            if (snapshotDigest(body.snapshot) !== body.snapshotHash) { send(422, { error: { code: 'SNAPSHOT_HASH_MISMATCH' } }); return; }
            const a = existing ?? { id: `00000000-0000-4000-8000-${String(this.attempts.size + 1).padStart(12, '0')}`, key: key!, body: text,
              snapshotHash: body.snapshotHash, referralResolutionId: body.referralResolutionId,
              payable: body.snapshot.totalContractAmountKopecks };
            this.attempts.set(ref, a);
            if (answer) send(201, { checkoutAttemptId: a.id, snapshotHash: a.snapshotHash, customerStatusUrl: 'https://checkout.example/s', obligations: [] });
          };
          if (this.state.attempt === 'ACCEPTED_TIMEOUT') accept(false);
          else behave(this.state.attempt, () => accept(true));
        } else if (req.method === 'GET' && (m = /^\/integrations\/merchant-orders\/([^/]+)$/.exec(path))) {
          const a = this.attempts.get(m[1]!);
          if (!a) { send(404, { error: { code: 'NOT_FOUND' } }); return; }
          send(200, { id: '10000000-0000-4000-8000-000000000001', merchantOrderId: m[1], status: 'OPEN',
            checkoutAttempts: [this.projection(a)] });
        } else if (req.method === 'POST' && /\/payment-session$/.test(path) && this.#gate !== null) {
          const gate = this.#gate;
          this.#gate = null;
          gate.arrived();
          void gate.released.then(() => send(200, { status: 'PAYMENT_READY', providerPaymentUrl: 'https://pay.alfa.example/form?mdOrder=1', supportReference: 'x' }));
        } else if (req.method === 'POST' && /\/payment-session$/.test(path)) {
          const s = this.state.session;
          if (s === 'READY') send(200, { status: 'PAYMENT_READY', providerPaymentUrl: 'https://pay.alfa.example/form?mdOrder=1', supportReference: 'x' });
          else if (s === 'PROCESSING') send(200, { status: 'PAYMENT_PROCESSING', supportReference: 'x' });
          else if (s === 'FAILED') send(200, { status: 'PAYMENT_FAILED', failureCode: 'PAYMENT_DECLINED', supportReference: 'x' });
          else behave(s, () => undefined);
        } else if (req.method === 'GET' && (m = /^\/integrations\/orders\/([^/]+)\/checkout-attempts\/([^/]+)$/.exec(path))) {
          const a = this.attempts.get(m[1]!);
          if (!a || a.id !== m[2]) { send(404, { error: { code: 'NOT_FOUND' } }); return; }
          send(200, this.projection(a));
        } else if (req.method === 'POST' && (m = /^\/integrations\/orders\/([^/]+)\/checkout-attempts\/([^/]+)\/cancel$/.exec(path))) {
          behave(this.state.cancel as Behaviour, () => {
            this.state.attemptStatus = 'CANCELLED';
            send(200, this.projection(this.attempts.get(m![1]!)!));
          });
        } else if (req.method === 'POST' && /\/fulfillment-ack$/.test(path)) {
          send(200, { checkoutAttemptId: 'x', status: 'DELIVERED' });
        } else {
          send(404, { error: { code: 'NOT_FOUND' } });
        }
      });
    });
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/v1-rc`;
  }

  stop(): Promise<void> {
    this.#server?.closeAllConnections();
    return new Promise((r) => this.#server?.close(() => r()));
  }

  reset(): void {
    this.#gate = null;
    this.requests.length = 0;
    this.attempts.clear();
    this.state = { discountKopecks: 0, attempt: 'OK', session: 'READY', cancel: 'OK', obligation: 'IN_PROGRESS',
      attemptStatus: 'OPEN', paymentAmountDelta: 0, projectionMismatch: false, projectionResolutionMismatch: false };
  }

  calls(pattern: RegExp, method = 'POST'): Recorded[] {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path));
  }

  private projection(a: { id: string; snapshotHash: string; referralResolutionId: string; payable: number }) {
    const satisfied = this.state.obligation === 'SATISFIED' || this.state.obligation === 'LATE_PAYMENT';
    return { id: a.id, status: this.state.attemptStatus,
      snapshotHash: this.state.projectionMismatch ? `refref-jcs-1:${'0'.repeat(64)}` : a.snapshotHash,
      referralResolutionId: this.state.projectionResolutionMismatch
        ? '00000000-0000-4000-8000-000000000099' : a.referralResolutionId,
      obligations: [{
      obligationRef: 'full', kind: 'FULL', executionMode: 'ORCHESTRATED', amountKopecks: a.payable, status: this.state.obligation,
      payment: satisfied ? { id: '11111111-1111-4111-8111-111111111111', status: 'SUCCEEDED',
        amountKopecks: a.payable + this.state.paymentAmountDelta, remainingRefundableAmountKopecks: a.payable,
        succeededAt: '2026-10-04T06:10:00Z' } : null,
    }] };
  }

  private inputHash(orderRef: string, lines: Json[]): string {
    return resolutionInputHash(this.merchantId, orderRef, lines as unknown as ResolutionLine[]);
  }
}
