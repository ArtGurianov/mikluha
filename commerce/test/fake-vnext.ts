// Refref's vNext claimArrival (docs/openapi-vnext.yaml) as a local HTTP server: issued proofs, one
// context per Arrival, 30-minute claims. Shared by the deferred Arrival tests and the native-ingress
// tests, which prove it receives nothing.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export type Behaviour = 'OK' | 'HANG' | 'ERROR_500' | { status: number; code: string };

/** Refref's claimArrival (docs/openapi-vnext.yaml): issued proofs, one context per Arrival, 30m claims. */
export class FakeVnext {
  /** Every request that reached the server, parsed or not. */
  hits = 0;
  readonly requests: { path: string; key: string | undefined; body: Record<string, unknown> }[] = [];
  readonly issued = new Map<string, number>();
  readonly claims = new Map<string, string>();
  readonly closed = new Set<string>();
  /** Answers for the next claims, in order; then OK. */
  next: Behaviour[] = [];
  now = () => Date.now();
  base = '';
  active = 0;
  peak = 0;
  #server: Server | null = null;
  #hung: (() => void)[] = [];

  constructor(readonly storefrontOrigin: string) {}

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      this.hits++;
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { text += c; });
      req.on('end', () => {
        const body = JSON.parse(text) as { arrivalProof: string; browserContextId: string; storefrontOrigin: string };
        this.requests.push({ path: req.url ?? '', key: req.headers['idempotency-key'] as string | undefined, body });
        const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        this.active++; this.peak = Math.max(this.peak, this.active);
        res.once('close', () => { this.active--; });
        const b = this.next.shift() ?? 'OK';
        if (b === 'HANG') { this.#hung.push(() => res.destroy()); return; }
        if (b === 'ERROR_500') { send(500, { error: { code: 'INTERNAL' } }); return; }
        if (typeof b === 'object') { send(b.status, { error: { code: b.code } }); return; }
        const issuedAt = this.issued.get(body.arrivalProof);
        const owner = this.claims.get(body.arrivalProof);
        if (this.closed.has(body.browserContextId)) { send(409, { error: { code: 'CONTEXT_CLOSED' } }); return; }
        if (owner !== undefined && owner !== body.browserContextId) { send(409, { error: { code: 'ARRIVAL_ALREADY_CLAIMED' } }); return; }
        const receipt = { claimId: '5b0c7a8e-2f1d-4c3b-9a8e-7d6c5b4a3f21', browserContextId: body.browserContextId,
          storefrontOrigin: body.storefrontOrigin, claimedAt: new Date(this.now()).toISOString(),
          eligibleUntil: new Date(this.now() + 30 * DAY).toISOString() };
        if (owner !== undefined) { send(200, receipt); return; }
        if (issuedAt === undefined || this.now() > issuedAt + 30 * MINUTE || body.storefrontOrigin !== this.storefrontOrigin) {
          send(422, { error: { code: 'ARRIVAL_PROOF_INVALID' } }); return;
        }
        this.claims.set(body.arrivalProof, body.browserContextId);
        send(201, receipt);
      });
    });
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/v1-vnext`;
  }

  /** What r.refref.ru does on a click: a fresh `ar1.` proof, valid for claims for 30 minutes. */
  issue(): string {
    const proof = `ar1.${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
    this.issued.set(proof, this.now());
    return proof;
  }

  reset(): void {
    for (const h of this.#hung.splice(0)) h();
    this.peak = this.active;
    this.hits = 0; this.requests.length = 0; this.issued.clear(); this.claims.clear(); this.closed.clear(); this.next = [];
  }

  async stop(): Promise<void> {
    this.reset();
    this.#server?.closeAllConnections();
    await new Promise((r) => this.#server?.close(() => r(undefined)));
  }
}
