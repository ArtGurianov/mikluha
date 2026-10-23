// TOUR arrival on the commerce origin (Refref ADR-139 docs/29 §2, §4, §6, §8; Linear ART-382).
//
//   GET /arrive?arrival=<opaque proof>&to=<site path>
//
// Refref sends a referred browser straight here (`r.refref.ru/:code → book.…/arrive?arrival=…`). The
// public site cannot capture anything server-side, so this is where the browser context lives:
//   * reuse the browser's ACTIVE context from its cookie, or create one: 32 random bytes, so it is
//     unguessable and carries no buyer identity;
//   * keep the raw proof in this process's memory only, tied to that context, for at most 30 minutes
//     after capture. Never in Postgres (its backups would outlive the proof), never in a log, never
//     in a Location header;
//   * answer with the context cookie (__Host-: host-only, Secure, HttpOnly, SameSite=Lax, 30 days,
//     the Mikluha attribution window) and a 302 to a clean page of the public site, without waiting
//     for Refref;
//   * after the response, claim the proof into the context (≈500 ms per attempt), and again after
//     every later request of the same context while the claim is unconfirmed (single-flight,
//     throttled). There is no durable queue: a restart loses pending proof, an accepted risk (§6).
//
// Before Buy, `beforeBuy` spends at most 1,500 ms on the pending claims and reports what checkout must
// freeze as `deliveryDegraded` (§6). Refref receives the proof, the context ID and this service's own
// origin: never a tourist's name, document, date of birth, phone or email.

import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';

import type { SchemaAdmission } from './schema-admission.js';
import { ExpiryQueue } from './expiry-queue.js';
import type { Logger } from './log.js';
import type { ArrivalClaimReceipt, RefrefResult } from './refref.js';
import { errorCode } from './refref.js';

/** Host-only (__Host-), so the static site or another subdomain can neither read nor set it. */
export const CONTEXT_COOKIE = '__Host-mk_ctx';
/** The Mikluha attribution window (owner decision 2026-10-17): the cookie must cover it. */
export const CONTEXT_MAX_AGE_SECONDS = 30 * 24 * 3600;
/** Refref accepts new claims until issuedAt + 30 minutes; the proof is captured right after issuance. */
export const CLAIM_TTL_MS = 30 * 60_000;
/** The ceiling of one exchange attempt (docs/29 §6). */
export const ATTEMPT_CEILING_MS = 500;
/** The whole pre-Buy exchange/readback budget (docs/29 §6). */
export const BUY_BUDGET_MS = 1_500;
/** Same-context requests closer together than this share one attempt. */
export const RETRY_INTERVAL_MS = 2_000;
/** Per-process admission limits, shared by after-response attempts and Buy. */
export const MAX_ACTIVE_CLAIMS = 16;
export const MAX_QUEUED_CLAIMS = 64;

type ClaimResult = RefrefResult<ArrivalClaimReceipt>;
interface QueuedClaim {
  start(): void;
  expire(): void;
}

/** Bounded FIFO: queue time consumes the attempt deadline; overload keeps proof pending. */
class ClaimQueue {
  #active = 0;
  readonly #waiting: QueuedClaim[] = [];

  run(deadline: number, task: (left: number) => Promise<ClaimResult>): Promise<ClaimResult> {
    if (this.#active >= MAX_ACTIVE_CLAIMS && this.#waiting.length >= MAX_QUEUED_CLAIMS) {
      return Promise.resolve({ kind: 'UNKNOWN', cause: 'OVERLOADED' });
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: QueuedClaim = {
        expire: () => {
          const i = this.#waiting.indexOf(entry);
          if (i !== -1) this.#waiting.splice(i, 1);
          resolve({ kind: 'UNKNOWN', cause: 'QUEUE_TIMEOUT' });
        },
        start: () => {
          if (timer !== undefined) clearTimeout(timer);
          const left = deadline - performance.now();
          if (left <= 0) { entry.expire(); return; }
          this.#active++;
          // Keep the slot until the actual transport settles, including on exceptions.
          Promise.resolve().then(() => task(left))
            .catch((): ClaimResult => ({ kind: 'UNKNOWN', cause: 'TRANSPORT' }))
            .then(resolve).finally(() => {
              this.#active--;
              this.#drain();
            });
        },
      };
      if (this.#active < MAX_ACTIVE_CLAIMS) entry.start();
      else {
        this.#waiting.push(entry);
        timer = setTimeout(entry.expire, Math.max(0, deadline - performance.now()));
      }
    });
  }

  #drain(): void {
    while (this.#active < MAX_ACTIVE_CLAIMS && this.#waiting.length > 0) this.#waiting.shift()!.start();
  }
}

/** Ours: 32 bytes, base64url. Refref accepts 32–128 of these characters; we accept only our own shape. */
const CONTEXT_ID = /^[A-Za-z0-9_-]{43}$/;
/** docs/openapi-vnext.yaml ArrivalClaimRequest.arrivalProof: opaque, 32–512 characters. */
const PROOF = /^[A-Za-z0-9._~-]{32,512}$/;
const MAX_TARGET_LENGTH = 512;
const MAX_PROOFS_PER_CONTEXT = 8;
const MAX_CONTEXTS = 50_000;

export const newContextId = () => randomBytes(32).toString('base64url');
export const validContextId = (v: string | undefined): v is string => v !== undefined && CONTEXT_ID.test(v);
export const validProof = (v: string | null): v is string => v !== null && PROOF.test(v);

export const contextCookie = (id: string) =>
  `${CONTEXT_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${CONTEXT_MAX_AGE_SECONDS}`;

/**
 * Where the buyer goes after arrival: a path on the public site, never anywhere else. Anything that
 * is not a plain absolute path of that origin (scheme, `//host`, backslash, control characters, an
 * over-long value) goes to the site's home page instead. Any `arrival` parameter is dropped.
 */
export function arrivalTarget(siteOrigin: string, to: string | null): string {
  const site = new URL(siteOrigin);
  const home = `${site.origin}/`;
  if (to === null || to === '' || to.length > MAX_TARGET_LENGTH) return home;
  if (!to.startsWith('/') || to.startsWith('//') || /[\\\u0000-\u001f\u007f\s]/u.test(to)) return home;
  let u: URL;
  try { u = new URL(to, site); } catch { return home; }
  if (u.origin !== site.origin || u.username !== '' || u.password !== '') return home;
  for (const k of [...u.searchParams.keys()]) if (k.toLowerCase() === 'arrival') u.searchParams.delete(k);
  return u.toString();
}

/** docs/openapi-vnext.yaml DeliveryDegraded, as checkout freezes it in the resolution request. */
export type DeliveryDegraded =
  | { readonly degraded: false }
  | { readonly degraded: true; readonly reason: 'TIMEOUT' | 'FAILED' | 'EXPIRED' };

export interface ArrivalClaimer {
  claimArrival(body: { arrivalProof: string; browserContextId: string; storefrontOrigin: string },
    deadlineMs: number): Promise<RefrefResult<ArrivalClaimReceipt>>;
}

/**
 * Work that must run after the response, kept alive by the process: the server drains it on
 * shutdown. An untracked fire-and-forget promise does not satisfy docs/29 §6.
 */
export class AfterResponse {
  readonly #tasks = new Set<Promise<void>>();
  #stopping = false;
  constructor(private readonly admission?: Pick<SchemaAdmission, 'run' | 'schedule' | 'canScheduleFromRequest'>) {}

  /** Register before response close, including from a live admitted request during drain. */
  schedule(res: ServerResponse, task: () => Promise<void>, settled?: () => void): void {
    if (this.#stopping && !this.admission?.canScheduleFromRequest()) { settled?.(); return; }
    const start = new Promise<void>(resolve => {
      if (res.closed) resolve();
      else res.once('close', resolve);
    });
    const work = this.admission ? this.admission.schedule(start, task) : start.then(task);
    void this.#track(work).finally(settled);
  }

  run(task: () => Promise<void>): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    return this.#track(this.admission ? this.admission.run(task) : Promise.resolve().then(task));
  }

  #track(work: Promise<unknown>): Promise<void> {
    const p = work.then(() => undefined, () => undefined).finally(() => { this.#tasks.delete(p); });
    this.#tasks.add(p);
    return p;
  }

  get pending(): number { return this.#tasks.size; }
  stop(): void { this.#stopping = true; }
  async drain(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }
}

type ProofState = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';

interface Proof {
  /** The raw proof while a claim is still possible; null afterwards. */
  raw: string | null;
  readonly expiresAt: number;
  state: ProofState;
  confirmedAt: number | null;
  /** A proof never tried yet is never throttled: each arrival gets its own after-response attempt. */
  tried: boolean;
}

interface Context {
  readonly proofs: Proof[];
  inFlight: Promise<void> | null;
  scheduled: boolean;
  lastAttemptAt: number;
  /** Refref refused the context as CLOSED, expired or another scope: it is never presented again. */
  closed: boolean;
  /** For a closed context: the one that replaced it, so a second tab with the old cookie joins it. */
  successor: string | null;
  touchedAt: number;
}

/** Codes after which this proof can never be claimed (docs/openapi-vnext.yaml claimArrival). */
const DEFINITIVE = new Set(['ARRIVAL_ALREADY_CLAIMED', 'ARRIVAL_PROOF_INVALID']);
/** Codes about the context, not the proof: the context rotates and the proof follows the browser. */
const CONTEXT_REFUSED = new Set(['CONTEXT_CLOSED', 'CONTEXT_SCOPE_MISMATCH']);
const CONFIGURATION_REFUSED = new Set(['BROWSER_CONTEXT_IDLE_POLICY_REQUIRED']);

export interface ArrivalDeps {
  readonly refref: ArrivalClaimer | null;
  /** This service's verified origin; never a buyer-supplied value. */
  readonly storefrontOrigin: string;
  readonly log: Logger;
  readonly now?: () => Date;
  readonly after?: AfterResponse;
}

/**
 * The browser contexts this process knows and their pending proof. Memory only and bounded: the
 * oldest contexts are forgotten first, which is the same accepted loss as a restart.
 */
export class Arrivals {
  readonly #contexts = new Map<string, Context>();
  readonly #deps: ArrivalDeps;
  readonly #claims = new ClaimQueue();
  readonly #retained = new ExpiryQueue<Proof>();
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;
  #expiryTimerAt = Infinity;
  readonly after: AfterResponse;

  constructor(deps: ArrivalDeps) {
    this.#deps = deps;
    this.after = deps.after ?? new AfterResponse();
  }

  #now(): number { return (this.#deps.now ?? (() => new Date()))().getTime(); }

  #entry(id: string, create: boolean): Context | undefined {
    let c = this.#contexts.get(id);
    if (c === undefined && create) {
      c = { proofs: [], inFlight: null, scheduled: false, lastAttemptAt: -Infinity, closed: false, successor: null, touchedAt: this.#now() };
      this.#contexts.set(id, c);
      if (this.#contexts.size > MAX_CONTEXTS) {
        const oldest = this.#contexts.keys().next().value!;
        for (const p of this.#contexts.get(oldest)!.proofs) this.#settle(p, 'EXPIRED');
        this.#contexts.delete(oldest);
      }
    }
    return c;
  }

  /**
   * The ACTIVE context for a request: the cookie's when it is ours and not refused by Refref, else a
   * new one. `rotated` is true when a refused context was replaced; its unconfirmed proof follows
   * this browser into the new context (TOUR is a guest storefront: there is no account boundary).
   */
  resolveContext(cookie: string | undefined): { id: string; isNew: boolean; rotated: boolean } {
    if (validContextId(cookie)) {
      const known = this.#contexts.get(cookie);
      if (known === undefined || !known.closed) return { id: cookie, isNew: false, rotated: false };
      if (known.successor !== null && this.#contexts.has(known.successor)) {
        return { id: known.successor, isNew: true, rotated: true };
      }
      const id = newContextId();
      const next = this.#entry(id, true)!;
      for (const p of known.proofs) if (p.state === 'PENDING') next.proofs.push(p);
      // The refused ID stays as a tombstone (no proof) pointing to its successor.
      known.proofs.length = 0;
      known.successor = id;
      this.#deps.log('browser_context_rotated', { carriedProofs: next.proofs.length });
      return { id, isNew: true, rotated: true };
    }
    return { id: newContextId(), isNew: true, rotated: false };
  }

  /** Keep the proof for this context; false when it is not shaped like a Refref proof. */
  capture(contextId: string, proof: string): boolean {
    const c = this.#entry(contextId, true)!;
    c.touchedAt = this.#now();
    if (c.proofs.some((p) => p.raw === proof)) return true;
    const p: Proof = { raw: proof, expiresAt: this.#now() + CLAIM_TTL_MS, state: 'PENDING', confirmedAt: null, tried: false };
    c.proofs.push(p);
    this.#retained.add(p);
    this.#scheduleExpiry();
    // Settled records go first; a context never holds more than a handful of arrivals.
    while (c.proofs.length > MAX_PROOFS_PER_CONTEXT) {
      const i = c.proofs.findIndex((p) => p.state !== 'PENDING');
      for (const removed of c.proofs.splice(i === -1 ? 0 : i, 1)) this.#settle(removed, 'EXPIRED');
    }
    this.#deps.log('arrival_captured', {});
    return true;
  }

  /** Is there anything to claim for this context? */
  hasPending(contextId: string): boolean {
    const c = this.#contexts.get(contextId);
    return c !== undefined && c.proofs.some((p) => p.state === 'PENDING');
  }

  /** After this response, try the context's pending claims (single-flight, throttled). */
  afterResponse(res: ServerResponse, contextId: string): void {
    const c = this.#contexts.get(contextId);
    if (c === undefined || c.scheduled || !this.hasPending(contextId)) return;
    c.scheduled = true;
    this.after.schedule(res, async () => {
      // Fresh proofs captured during a shared in-flight claim belong to this registered task.
      // Keep them in its drain obligation instead of needing a new admission after SIGTERM.
      do { await this.attempt(contextId, ATTEMPT_CEILING_MS, false); }
      while (!c.closed && c.proofs.some(p => p.state === 'PENDING' && !p.tried));
    }, () => { c.scheduled = false; });
  }

  /**
   * One bounded attempt over every pending proof of the context. Concurrent callers share the one in
   * flight (a proof captured meanwhile gets the next one); unless `force`d or a proof was never
   * tried, an attempt within RETRY_INTERVAL_MS of the previous one is skipped.
   */
  attempt(contextId: string, ceilingMs: number, force: boolean): Promise<void> {
    const c = this.#contexts.get(contextId);
    if (c === undefined) return Promise.resolve();
    const fresh = () => c.proofs.some((p) => p.state === 'PENDING' && !p.tried);
    if (c.inFlight !== null) return c.inFlight;
    const now = this.#now();
    this.#expire(c, now);
    if (c.closed || !c.proofs.some((p) => p.state === 'PENDING')) return Promise.resolve();
    if (!force && !fresh() && now - c.lastAttemptAt < RETRY_INTERVAL_MS) return Promise.resolve();
    c.lastAttemptAt = now;
    const deadline = performance.now() + Math.min(ATTEMPT_CEILING_MS, Math.max(0, ceilingMs));
    const p = this.#claimAll(contextId, c, deadline).finally(() => {
      c.inFlight = null;
      // A new arrival during this attempt gets one coalesced, tracked follow-up, not a chain per request.
      if (!c.closed && fresh()) void this.after.run(() => this.attempt(contextId, ATTEMPT_CEILING_MS, false));
    });
    c.inFlight = p;
    return p;
  }

  async #claimAll(contextId: string, c: Context, deadline: number): Promise<void> {
    const refref = this.#deps.refref;
    const log = this.#deps.log;
    if (refref === null) {
      // No vNext API configured: the proof cannot be delivered. Checkout will declare it.
      for (const p of c.proofs) if (p.state === 'PENDING') p.tried = true;
      log('arrival_claim_unknown', { cause: 'VNEXT_NOT_CONFIGURED' });
      return;
    }
    const pending = c.proofs.filter((p) => p.state === 'PENDING' && p.raw !== null);
    for (const p of pending) p.tried = true;
    await Promise.all(pending.map(async (p) => {
      const r = await this.#claims.run(deadline, (left) => {
        this.#expire(c, this.#now());
        if (p.raw === null || p.state !== 'PENDING' || c.closed) {
          return Promise.resolve({ kind: 'UNKNOWN', cause: 'NO_LONGER_PENDING' });
        }
        return refref.claimArrival({ arrivalProof: p.raw, browserContextId: contextId,
          storefrontOrigin: this.#deps.storefrontOrigin }, Math.min(left, p.expiresAt - this.#now()));
      });
      if (p.state !== 'PENDING') return;
      if (r.kind === 'ANSWERED' && (r.status === 200 || r.status === 201)) {
        this.#settle(p, 'CONFIRMED');
        log('arrival_claim_confirmed', { replay: r.status === 200 });
        return;
      }
      if (r.kind === 'UNKNOWN') {
        // Possibly committed: an exact repeat is Refref's readback of it.
        log('arrival_claim_unknown', { cause: r.cause });
        return;
      }
      const code = errorCode(r.body);
      if (r.status === 401 || r.status === 403 || CONFIGURATION_REFUSED.has(code)) {
        this.#settle(p, 'FAILED');
        log('arrival_claim_configuration_failed', { status: r.status, code });
      } else if (r.status === 400 || DEFINITIVE.has(code)) {
        this.#settle(p, 'FAILED');
        log('arrival_claim_failed', { code });
      } else if (CONTEXT_REFUSED.has(code)) {
        c.closed = true;
        log('arrival_claim_context_refused', { code });
      } else {
        // An unclassified response is uncertain: preserve proof for exact replay/readback.
        log('arrival_claim_unknown', { cause: code });
      }
    }));
    this.#expire(c, this.#now());
  }

  #settle(p: Proof, state: ProofState): void {
    p.state = state;
    if (state === 'CONFIRMED') p.confirmedAt = performance.now();
    p.raw = null;
    this.#retained.delete(p);
    if (this.#retained.size === 0 && this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
  }

  /** One unref'ed timer for the next expiry, independent of HTTP requests or claims. */
  #scheduleExpiry(): void {
    const earliest = this.#retained.peek()?.expiresAt;
    if (earliest === undefined) return;
    if (this.#expiryTimer !== null) {
      if (this.#expiryTimerAt <= earliest) return;
      clearTimeout(this.#expiryTimer);
    }
    this.#expiryTimerAt = earliest;
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null;
      const now = this.#now();
      let p: Proof | undefined;
      while ((p = this.#retained.peek()) !== undefined && now >= p.expiresAt) {
        this.#settle(p, 'EXPIRED');
        this.#deps.log('arrival_claim_expired', {});
      }
      this.#scheduleExpiry();
    }, Math.max(0, earliest - this.#now()));
    this.#expiryTimer.unref();
  }

  /** Credential-free retention diagnostic. Reading it does not expire or mutate anything. */
  get retainedRawProofs(): number {
    let count = 0;
    for (const c of this.#contexts.values()) for (const p of c.proofs) if (p.raw !== null) count++;
    return count;
  }

  #expire(c: Context, now: number): void {
    for (const p of c.proofs) {
      if (p.state === 'PENDING' && now >= p.expiresAt) {
        this.#settle(p, 'EXPIRED');
        this.#deps.log('arrival_claim_expired', {});
      }
    }
  }

  /**
   * Before Buy: up to `budgetMs` of attempts on this context's pending claims, then what the order
   * freezes as `deliveryDegraded`. Any proof still unconfirmed makes it degraded; a still-pending one
   * is TIMEOUT even if it may have committed. Late success never clears a value already frozen.
   */
  async beforeBuy(contextId: string, budgetMs = BUY_BUDGET_MS): Promise<DeliveryDegraded> {
    const deadline = performance.now() + Math.min(BUY_BUDGET_MS, Math.max(0, budgetMs));
    for (;;) {
      const c = this.#contexts.get(contextId);
      if (c === undefined || c.closed || !c.proofs.some((p) => p.state === 'PENDING')) break;
      const left = deadline - performance.now();
      if (left <= 0) break;
      // This includes waiting on an existing attempt, queue admission and any newer arrival.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.attempt(contextId, Math.min(ATTEMPT_CEILING_MS, left), true),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, left); }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (this.#deps.refref === null) break;
      // An attempt that ended early with an uncertain outcome is retried after a short pause.
      if (this.hasPending(contextId)) await new Promise((r) => setTimeout(r, Math.min(50, Math.max(0, deadline - performance.now()))));
    }
    return this.degradation(contextId, deadline);
  }

  /** What is known now about undelivered proof of this context. */
  degradation(contextId: string, confirmedBy = Infinity): DeliveryDegraded {
    const c = this.#contexts.get(contextId);
    if (c === undefined) return { degraded: false };
    this.#expire(c, this.#now());
    // A late ACK can run before an overdue deadline timer when the event loop was busy.
    if (c.proofs.some((p) => p.state === 'PENDING' || (p.confirmedAt !== null && p.confirmedAt > confirmedBy))) {
      return { degraded: true, reason: 'TIMEOUT' };
    }
    if (c.proofs.some((p) => p.state === 'FAILED')) return { degraded: true, reason: 'FAILED' };
    if (c.proofs.some((p) => p.state === 'EXPIRED')) return { degraded: true, reason: 'EXPIRED' };
    return { degraded: false };
  }
}
